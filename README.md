# Claude-to-OpenAI API 代理

这是一个部署在 Cloudflare Workers 上的 TypeScript 项目，它充当一个代理服务器，能够将 [Claude API](https://docs.anthropic.com/claude/reference/messages_post) 格式的请求无缝转换为 [OpenAI API](https://platform.openai.com/docs/api-reference/chat/create) 格式。这使得任何与 Claude API 兼容的客户端（例如官方的 `@anthropic-ai/claude-code` CLI）都能够与任何支持 OpenAI API 格式的服务进行通信，如 Google Gemini, Groq, Ollama 等。

## ✨ 功能特性

  * **动态路由**：无需修改或重新部署代码，即可将请求代理到任意 OpenAI 兼容的 API 端点。目标 API 的地址和模型名称可以直接在请求的 URL 路径中动态指定。
  * **全功能 API 兼容**：完全支持 Claude 的 `/v1/messages` 端点，包括流式 (streaming) 和非流式响应。
  * **Tool Calling (函数调用)转换**：自动且智能地将 Claude 的 `tools` 格式转换为 OpenAI 的格式。同时会对 `input_schema` 进行清理，以确保与 Google Gemini 等要求严格的 API 兼容。
  * **Haiku 模型快捷方式**：可透过 Cloudflare 的环境变量，为特定的 "Haiku" 模型配置一个固定的路由，方便快速调用。
  * **一键配置脚本**：提供 `claude_proxy.sh` 脚本，通过交互式问答，引导用户一键完成本地 `claude` CLI 工具的安装与配置。
  * **轻松部署**：可以一键将服务部署到 Cloudflare Workers 的全球网络。

## 🔬 工作原理：神奇的动态路由

本代理最核心的功能是其动态路由机制。它通过解析请求的 URL 来决定最终要访问的目标 API 和模型。

**URL 格式**：
`https://<你的代理地址>/<协议>/<目标API域名>/<路径>/<模型名称>/v1/messages`

**处理流程**：

1.  当一个请求发送到代理地址时，代理会解析 URL，从中提取出目标服务的 Base URL (例如 `https://api.groq.com/openai/v1`) 和模型名称 (例如 `llama3-70b-8192`)。
2.  代理会将请求标头 (Header) 中的 `x-api-key` 作为 `Authorization: Bearer <key>` 转发给目标 API。
3.  代理将 Claude 格式的请求体 (Body) 转换为 OpenAI 格式，然后发送到目标的 `/chat/completions` 端点。
4.  最后，代理将收到的 OpenAI 格式响应转换回 Claude 格式，并返回给原始的客户端。

## 🚀 快速上手

我们强烈推荐使用 `claude_proxy.sh` 脚本来进行配置，它会自动处理所有设定。

### 步骤 1: 执行配置脚本

打开您的终端，直接执行以下命令：

```bash
chmod +x ./claude_proxy.sh
./claude_proxy.sh
```

### 步骤 2: 跟随互动提示进行设置

脚本将会引导您完成设置，您需要输入以下信息：

1.  **Worker URL**：您的代理服务地址。如果您尚未部署自己的服务，可以直接使用预设的公共地址 (`https://claude-code-proxy.suixifa.workers.dev`)。
2.  **API Key**：**您的目标服务 API 密钥**。例如，如果您想使用 Groq，这里就填写您的 Groq API Key。
3.  **OpenAI URL**：**您的目标服务 API 地址** (不含 `http(s)://` 协议头)。例如，Groq 的地址是 `api.groq.com/openai/v1`。
4.  **模型名称**：您希望使用的模型，例如 `llama3-70b-8192`。

脚本会自动检查并安装 `claude` 命令行工具，并将您的设置写入 `~/.claude/settings.json`。完成后，脚本还会发送一个测试请求来验证代理连接是否成功。

### 步骤 3: 开始使用！

配置完成后，您就可以直接在终端中使用 `claude` 命令，它将通过您设置的代理与指定的模型进行通讯。

```bash
claude "你好，世界！"
```

## 🛠️ 进阶用法：自托管部署

如果您希望拥有自己的代理服务，可以按照以下步骤将此项目部署到您自己的 Cloudflare 账户。

### 1\. 部署到 Cloudflare

1.  **安装 Wrangler**：Wrangler 是 Cloudflare 的官方命令行工具。
    ```bash
    npm install -g wrangler
    ```
2.  **配置 `wrangler.toml` (可选)**：
    您可以修改 `wrangler.toml` 文件中的 `[vars]` 部分，为 "Haiku" 模型设置一个备用或默认的 API 端点。
3.  **登录并部署**：
    ```bash
    npx wrangler login
    npx wrangler deploy
    ```
    部署成功后，您将获得一个 `*.workers.dev` 的域名，例如 `my-proxy.workers.dev`。这就是您自己的代理服务地址。

### 2\. 配置客户端使用自托管代理

部署完成后，再次执行 `claude_proxy.sh` 脚本，并在提示时输入您自己的 Worker URL 即可。

## 💻 本地开发

如果您想在本地端运行和测试此 Worker：

1.  **创建 `.dev.vars` 文件**：在本地开发时，Wrangler 需要一个 `.dev.vars` 文件来读取环境变量。
    ( 或在`wrangler.toml`文件中) 将`haiku`模型指向到目标模型。内容示例如下：
    ```
    HAIKU_MODEL_NAME="gpt-4o-mini"
    HAIKU_BASE_URL="https://api.your-provider.com/v1"
    HAIKU_API_KEY="sk-your-secret-key"
    ```
3.  **启动本地服务器**：
    ```bash
    npx wrangler dev
    ```
    这将在本地 `http://localhost:8787` 启动一个开发服务器。
4.  **启动Claude Code**
    在另一个终端窗口中
    ```bash
    export ANTHROPIC_BASE_URL=http://localhost:8787
    export API_TIMEOUT_MS=600000
    export ANTHROPIC_MODEL=haiku
    export ANTHROPIC_SMALL_FAST_MODEL=haiku
    ```
    然后执行
    ```bash
    claude "hi"
    ```
