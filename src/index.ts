/**
 * Claude-to-OpenAI API Proxy for Cloudflare Workers
 *
 * This worker acts as a proxy, converting API requests from the Claude format to the OpenAI format,
 * and then converting the responses back. It enables using OpenAI-compatible APIs (like OpenAI,
 * Azure OpenAI, Google Gemini, Ollama, etc.) with clients designed for the Claude API.
 *
 * Features:
 * - Full support for the /v1/messages endpoint.
 * - Dynamic Routing: Routes requests to any OpenAI-compatible API by embedding the target URL and
 * model in the request path. For example, a request to the path
 * `/https/api.groq.com/openai/v1/llama3-70b-8192/v1/messages` will be forwarded to the Groq API.
 * - Correctly handles and translates tool calls (function calling), including cleaning schemas
 * for compatibility with strict APIs like Google Gemini.
 * - Supports streaming responses (Server-Sent Events).
 * - Dynamically selects API endpoints and keys based on the requested model name (e.g., "haiku")
 * or the dynamic URL path.
 * - Designed for easy deployment on Cloudflare Workers.
 */

// --- TYPE DEFINITIONS ---

/**
 * Environment variables configured in your wrangler.toml or Cloudflare dashboard.
 */
export interface Env {
    /**
     * Pre-configured route for a "haiku" model for easier access.
     */
    HAIKU_MODEL_NAME: string;
    HAIKU_BASE_URL: string;
    HAIKU_API_KEY: string;
}

// --- Claude API Types ---

interface ClaudeTool {
    name: string;
    description?: string;
    input_schema: any;
}

type ClaudeContent =
    | string
    | Array<{
    type: "text" | "image" | "tool_use" | "tool_result";
    text?: string;
    source?: {
        type: "base64";
        media_type: string;
        data: string;
    };
    id?: string;
    name?: string;
    input?: any;
    tool_use_id?: string;
    content?: any;
}>;

interface ClaudeMessage {
    role: "user" | "assistant";
    content: ClaudeContent;
}

interface ClaudeMessagesRequest {
    model: string;
    messages: ClaudeMessage[];
    system?: string;
    max_tokens: number;
    stop_sequences?: string[];
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    tools?: ClaudeTool[];
    tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
}

// --- OpenAI API Types ---

interface OpenAIMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | Array<{ type: "text" | "image_url"; text?: string; image_url?: { url: string } }>;
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
}

interface OpenAIToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}

interface OpenAIRequest {
    model: string;
    messages: OpenAIMessage[];
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stop?: string[];
    stream?: boolean;
    tools?: Array<{ type: "function"; function: any }>;
    tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
}

// --- Main Worker Logic ---

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        if (request.method === "OPTIONS") {
            return handleOptions();
        }

        const url = new URL(request.url);
        // All valid requests must end with `/v1/messages`.
        if (!url.pathname.endsWith("/v1/messages")) {
            return new Response("Not Found. URL must end with /v1/messages", { status: 404 });
        }

        if (request.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405 });
        }

        const apiKey = request.headers.get('x-api-key');
        if (!apiKey) {
        //    return new Response(JSON.stringify({ error: 'The "x-api-key" header is missing.' }), {
        //        status: 401,
        //        headers: { 'Content-Type': 'application/json' },
        //    });
        }

        try {
            const claudeRequest: ClaudeMessagesRequest = await request.json();

            // --- Configuration Selection ---
            // The API key from the header is used by default for all dynamic requests.
            let targetApiKey: string; // = apiKey;
            let targetModelName: string;
            let targetBaseUrl: string;

            // Check for the "haiku" specific route first.
            const isHaiku = claudeRequest.model.toLowerCase().includes("haiku");
            if (isHaiku) {
                targetModelName = env.HAIKU_MODEL_NAME;
                targetBaseUrl = env.HAIKU_BASE_URL;
                targetApiKey = env.HAIKU_API_KEY; // Use the specific key for Haiku
            } else {
                // Try to parse the base URL and model from the dynamic path.
                const dynamicConfig = parsePathAndModel(url.pathname);
                if (dynamicConfig) {
                    targetBaseUrl = dynamicConfig.baseUrl;
                    targetModelName = dynamicConfig.modelName;
                } else {
                    return new Response(JSON.stringify({ error: 'The "url" is missing.' }), {
                        status: 401,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
            }

            if (!targetBaseUrl || !targetModelName) {
                return new Response(JSON.stringify({ error: 'Could not determine target base URL or model name. Ensure the URL format is correct or fallback environment variables are set.' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
                });
            }

            const target = {
                modelName: targetModelName,
                baseUrl: targetBaseUrl,
                apiKey: targetApiKey,
            };

            const openaiRequest = convertClaudeToOpenAIRequest(claudeRequest, target.modelName);

            const openaiApiResponse = await fetch(`${target.baseUrl}/chat/completions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${target.apiKey}`,
                },
                body: JSON.stringify(openaiRequest),
            });

            if (!openaiApiResponse.ok) {
                const errorBody = await openaiApiResponse.text();
                return new Response(errorBody, {
                    status: openaiApiResponse.status,
                    statusText: openaiApiResponse.statusText,
                    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
                });
            }

            if (claudeRequest.stream) {
                const transformStream = new TransformStream({
                    transform: streamTransformer(claudeRequest.model),
                });
                return new Response(openaiApiResponse.body!.pipeThrough(transformStream), {
                    headers: { "Content-Type": "text/event-stream", ...corsHeaders() },
                });
            } else {
                const openaiResponse = await openaiApiResponse.json();
                const claudeResponse = convertOpenAIToClaudeResponse(openaiResponse, claudeRequest.model);
                return new Response(JSON.stringify(claudeResponse), {
                    headers: { "Content-Type": "application/json", ...corsHeaders() },
                });
            }
        } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), {
                status: 500,
                headers: { "Content-Type": "application/json", ...corsHeaders() },
            });
        }
    },
};

// ======================= Helper Functions =======================

/**
 * Parses the model and base URL from the request pathname.
 * The path is expected to be in the format: /<scheme>/<host>/.../<model_name>/v1/messages
 * or /<host>/.../<model_name>/v1/messages (defaulting to https).
 * @param pathname The URL pathname from the request.
 * @returns An object with `baseUrl` and `modelName`, or `null` if the path doesn't contain a dynamic configuration.
 */
function parsePathAndModel(pathname: string): { baseUrl: string; modelName: string } | null {
    // Remove the mandatory suffix to isolate the dynamic parts of the path.
    const dynamicPath = pathname.substring(0, pathname.lastIndexOf('/v1/messages'));
    const parts = dynamicPath.split('/').filter(p => p);

    if (parts.length < 2) {
        // Not enough parts for a dynamic configuration.
        // This occurs for requests to the root `/v1/messages`.
        return null;
    }

    // The last part of the dynamic path is the model name.
    const modelName = parts.pop()!;
    let baseUrl: string;

    // Reconstruct the base URL from the remaining parts.
    if (parts[0].toLowerCase() === 'http' || parts[0].toLowerCase() === 'https') {
        const scheme = parts.shift()!;
        baseUrl = `${scheme}://${parts.join('/')}`;
    } else {
        // If no scheme is provided, default to https.
        baseUrl = `https://${parts.join('/')}`;
    }

    return { baseUrl, modelName };
}

/**
 * Recursively cleans a JSON Schema to make it compatible with target APIs like Google Gemini.
 * - Removes '$schema' and 'additionalProperties' keys.
 * - For properties of type 'string', removes the 'format' field unless it's 'date-time' or 'enum'.
 * @param schema The schema object to clean.
 */
function recursivelyCleanSchema(schema: any): any {
    if (schema === null || typeof schema !== 'object') {
        return schema;
    }

    if (Array.isArray(schema)) {
        return schema.map(item => recursivelyCleanSchema(item));
    }

    const newSchema: { [key: string]: any } = {};
    for (const key in schema) {
        if (Object.prototype.hasOwnProperty.call(schema, key)) {
            if (key === '$schema' || key === 'additionalProperties') {
                continue;
            }
            newSchema[key] = recursivelyCleanSchema(schema[key]);
        }
    }

    if (newSchema.type === 'string' && newSchema.format) {
        const supportedFormats = ['date-time', 'enum'];
        if (!supportedFormats.includes(newSchema.format)) {
            delete newSchema.format;
        }
    }

    return newSchema;
}

/**
 * Converts a Claude API request to the OpenAI format.
 */
function convertClaudeToOpenAIRequest(
    claudeRequest: ClaudeMessagesRequest,
    modelName: string
): OpenAIRequest {
    const openaiMessages: OpenAIMessage[] = [];

    if (claudeRequest.system) {
        openaiMessages.push({ role: "system", content: claudeRequest.system });
    }

    for (let i = 0; i < claudeRequest.messages.length; i++) {
        const message = claudeRequest.messages[i];
        if (message.role === 'user') {
            if (Array.isArray(message.content)) {
                const toolResults = message.content.filter(c => c.type === 'tool_result');
                const otherContent = message.content.filter(c => c.type !== 'tool_result');

                if (toolResults.length > 0) {
                    toolResults.forEach(block => {
                        openaiMessages.push({
                            role: 'tool',
                            tool_call_id: block.tool_use_id!,
                            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
                        });
                    });
                }

                if (otherContent.length > 0) {
                    openaiMessages.push({ role: "user", content: otherContent.map(block => block.type === 'text' ? {type: 'text', text: block.text} : {type: 'image_url', image_url: {url: `data:${block.source!.media_type};base64,${block.source!.data}`}} ) as any});
                }
            } else {
                openaiMessages.push({ role: "user", content: message.content });
            }
        } else if (message.role === 'assistant') {
            const textParts: string[] = [];
            const toolCalls: OpenAIToolCall[] = [];
            if (Array.isArray(message.content)) {
                message.content.forEach(block => {
                    if (block.type === 'text') {
                        textParts.push(block.text!);
                    } else if (block.type === 'tool_use') {
                        toolCalls.push({
                            id: block.id!,
                            type: 'function',
                            function: { name: block.name!, arguments: JSON.stringify(block.input || {}) },
                        });
                    }
                });
            }
            const assistantMessage: OpenAIMessage = { role: 'assistant', content: textParts.join('\n') || null as any};
            if (toolCalls.length > 0) {
                assistantMessage.tool_calls = toolCalls;
            }
            openaiMessages.push(assistantMessage);
        }
    }

    const openaiRequest: OpenAIRequest = {
        model: modelName,
        messages: openaiMessages,
        max_tokens: claudeRequest.max_tokens,
        temperature: claudeRequest.temperature,
        top_p: claudeRequest.top_p,
        stream: claudeRequest.stream,
        stop: claudeRequest.stop_sequences,
    };

    if (claudeRequest.tools) {
        openaiRequest.tools = claudeRequest.tools.map((tool) => {
            const cleanedParameters = recursivelyCleanSchema(tool.input_schema);
            return {
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: cleanedParameters,
                },
            };
        });
    }

    if (claudeRequest.tool_choice) {
        if (claudeRequest.tool_choice.type === 'auto' || claudeRequest.tool_choice.type === 'any') {
            openaiRequest.tool_choice = 'auto';
        } else if (claudeRequest.tool_choice.type === 'tool') {
            openaiRequest.tool_choice = { type: 'function', function: { name: claudeRequest.tool_choice.name! }};
        }
    }

    return openaiRequest;
}

/**
 * Converts a non-streaming OpenAI response to the Claude format.
 */
function convertOpenAIToClaudeResponse(openaiResponse: any, model: string): any {
    const choice = openaiResponse.choices[0];
    const contentBlocks: any[] = [];
    if (choice.message.content) {
        contentBlocks.push({ type: 'text', text: choice.message.content });
    }
    if (choice.message.tool_calls) {
        choice.message.tool_calls.forEach((call: OpenAIToolCall) => {
            contentBlocks.push({
                type: 'tool_use',
                id: call.id,
                name: call.function.name,
                input: JSON.parse(call.function.arguments),
            });
        });
    }
    const stopReasonMap: Record<string, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use" };
    return {
        id: openaiResponse.id,
        type: "message",
        role: "assistant",
        model: model,
        content: contentBlocks,
        stop_reason: stopReasonMap[choice.finish_reason] || "end_turn",
        usage: {
            input_tokens: openaiResponse.usage.prompt_tokens,
            output_tokens: openaiResponse.usage.completion_tokens,
        },
    };
}

/**
 * Creates a transform function for the streaming response.
 */
function streamTransformer(model: string) {
    let initialized = false;
    let buffer = "";
    const messageId = `msg_${Math.random().toString(36).substr(2, 9)}`;
    const toolCalls: { [index: number]: { id: string, name: string, args: string, claudeIndex: number, started: boolean } } = {};
    let contentBlockIndex = 0;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const sendEvent = (controller: TransformStreamDefaultController, event: string, data: object) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    };
    return (chunk: Uint8Array, controller: TransformStreamDefaultController) => {
        if (!initialized) {
            sendEvent(controller, 'message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
            sendEvent(controller, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
            initialized = true;
        }
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.substring(6);
            if (data.trim() === "[DONE]") {
                sendEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: 0 });
                Object.values(toolCalls).forEach(tc => {
                    if(tc.started) sendEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: tc.claudeIndex });
                });
                let finalStopReason = "end_turn";
                try {
                    const lastChunk = JSON.parse(lines[lines.length - 2].substring(6));
                    const finishReason = lastChunk.choices[0].finish_reason;
                    if (finishReason === 'tool_calls') finalStopReason = 'tool_use';
                    if (finishReason === 'length') finalStopReason = 'max_tokens';
                } catch {}
                sendEvent(controller, 'message_delta', { type: 'message_delta', delta: { stop_reason: finalStopReason, stop_sequence: null }, usage: { output_tokens: 0 } });
                sendEvent(controller, 'message_stop', { type: 'message_stop' });
                controller.terminate();
                return;
            }
            try {
                const openaiChunk = JSON.parse(data);
                const delta = openaiChunk.choices[0]?.delta;
                if (!delta) continue;
                if (delta.content) {
                    sendEvent(controller, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } });
                }
                if (delta.tool_calls) {
                    for(const tc_delta of delta.tool_calls) {
                        const index = tc_delta.index;
                        if (!toolCalls[index]) {
                            toolCalls[index] = { id: '', name: '', args: '', claudeIndex: 0, started: false };
                        }
                        if (tc_delta.id) toolCalls[index].id = tc_delta.id;
                        if (tc_delta.function?.name) toolCalls[index].name = tc_delta.function.name;
                        if (tc_delta.function?.arguments) toolCalls[index].args += tc_delta.function.arguments;
                        if (toolCalls[index].id && toolCalls[index].name && !toolCalls[index].started) {
                            contentBlockIndex++;
                            toolCalls[index].claudeIndex = contentBlockIndex;
                            toolCalls[index].started = true;
                            sendEvent(controller, 'content_block_start', { type: 'content_block_start', index: contentBlockIndex, content_block: { type: 'tool_use', id: toolCalls[index].id, name: toolCalls[index].name, input: {} } });
                        }
                        if (toolCalls[index].started && tc_delta.function?.arguments) {
                            sendEvent(controller, 'content_block_delta', { type: 'content_block_delta', index: toolCalls[index].claudeIndex, delta: { type: 'input_json_delta', partial_json: tc_delta.function.arguments } });
                        }
                    }
                }
            } catch (e) {
                // Ignore JSON parse errors
            }
        }
    };
}

// --- CORS Handling ---

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, Anthropic-Version',
    };
}

function handleOptions() {
    return new Response(null, { headers: corsHeaders() });
}
