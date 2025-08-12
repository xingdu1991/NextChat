import { getServerSideConfig } from "../config/server";
import { Ollama } from "../constant";
import { ChatRequest, ChatResponse, RequestMessage } from "../client/api";
import { getMessageTextContent, isVisionModel } from "../utils";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "./auth";
import { cloudflareAIGatewayUrl } from "./common";

const serverConfig = getServerSideConfig();

export async function requestOllama(req: NextRequest) {
  const authResult = auth(req, serverConfig);
  if (authResult.error) {
    return NextResponse.json(authResult, {
      status: 401,
    });
  }

  try {
    const requestBody = await req.json();

    let baseUrl = serverConfig.ollamaUrl || Ollama.ExampleEndpoint;

    if (!baseUrl.includes("://")) {
      baseUrl = `http://${baseUrl}`;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, -1);
    }

    console.log("[Ollama Request] Using base URL:", baseUrl);

    const timeoutId = setTimeout(
      () => {
        controller.abort();
      },
      10 * 60 * 1000, // 10 minutes timeout
    );

    const controller = new AbortController();

    // Convert OpenAI format to Ollama format
    const ollamaRequest = {
      model: requestBody.model,
      messages: requestBody.messages,
      stream: requestBody.stream ?? true,
      options: {
        temperature: requestBody.temperature,
        top_p: requestBody.top_p,
        num_predict: requestBody.max_tokens,
      },
    };

    const fetchUrl = `${baseUrl}/${Ollama.ChatPath}`;
    
    console.log("[Ollama Request] URL:", fetchUrl);
    console.log("[Ollama Request] Body:", JSON.stringify(ollamaRequest, null, 2));

    const fetchOptions: RequestInit = {
      headers: {
        "Content-Type": "application/json",
        ...(serverConfig.ollamaApiKey && {
          Authorization: `Bearer ${serverConfig.ollamaApiKey}`,
        }),
      },
      method: req.method,
      body: JSON.stringify(ollamaRequest),
      signal: controller.signal,
    };

    const res = await fetch(fetchUrl, fetchOptions);
    
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.error("[Ollama Error] Response status:", res.status);
      const errorText = await res.text();
      console.error("[Ollama Error] Response text:", errorText);
      return NextResponse.json(
        {
          error: true,
          message: `Ollama API error: ${res.status} ${res.statusText}`,
          details: errorText,
        },
        {
          status: res.status,
        },
      );
    }

    // Handle streaming response
    if (ollamaRequest.stream) {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      
      const stream = new ReadableStream({
        async start(controller) {
          const reader = res.body?.getReader();
          if (!reader) {
            controller.close();
            return;
          }

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                break;
              }

              const chunk = decoder.decode(value, { stream: true });
              const lines = chunk.split('\n').filter(line => line.trim());
              
              for (const line of lines) {
                try {
                  const data = JSON.parse(line);
                  
                  // Convert Ollama format to OpenAI format
                  const openAIChunk = {
                    id: `chatcmpl-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: requestBody.model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content: data.message?.content || "",
                        },
                        finish_reason: data.done ? "stop" : null,
                      },
                    ],
                  };
                  
                  const formattedChunk = `data: ${JSON.stringify(openAIChunk)}\n\n`;
                  controller.enqueue(encoder.encode(formattedChunk));
                  
                  if (data.done) {
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    break;
                  }
                } catch (parseError) {
                  console.error("[Ollama Parse Error]:", parseError);
                }
              }
            }
          } catch (error) {
            console.error("[Ollama Stream Error]:", error);
            controller.error(error);
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    } else {
      // Handle non-streaming response
      const data = await res.json();
      
      // Convert Ollama format to OpenAI format
      const openAIResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestBody.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: data.message?.content || "",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: data.prompt_eval_count || 0,
          completion_tokens: data.eval_count || 0,
          total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
        },
      };
      
      return NextResponse.json(openAIResponse);
    }
  } catch (e) {
    console.error("[Ollama Error]", e);
    return NextResponse.json(
      {
        error: true,
        message: "Failed to make request to Ollama API",
        details: e instanceof Error ? e.message : String(e),
      },
      {
        status: 500,
      },
    );
  }
}
