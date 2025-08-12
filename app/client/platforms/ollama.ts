import {
  ApiPath,
  DEFAULT_API_HOST,
  DEFAULT_MODELS,
  Ollama,
  REQUEST_TIMEOUT_MS,
} from "../../constant";
import { useAccessStore, useAppConfig, useChatStore } from "../../store";
import { ChatMessage, ModelType, useAuthStore } from "../../store/auth";
import {
  ChatRequest,
  ChatResponse,
  RequestMessage,
  MultimodalContent,
  ClientApi,
  SpeechOptions,
  LLMModel,
} from "../api";
import Locale from "../../locales";
import {
  EventStreamContentType,
  fetchEventSource,
} from "@fortaine/fetch-event-source";
import { prettyObject } from "../../utils/format";
import { getClientConfig } from "../../config/client";
import { getMessageTextContent, isVisionModel } from "../../utils";

export interface OllamaListModelResponse {
  models: Array<{
    name: string;
    modified_at: string;
    size: number;
    digest: string;
    details: {
      format: string;
      family: string;
      families: string[];
      parameter_size: string;
      quantization_level: string;
    };
  }>;
}

export class OllamaApi implements ClientApi {
  private disableListModels = true;

  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.ollamaUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      const apiPath = isApp ? ApiPath.Ollama : "";
      baseUrl = [DEFAULT_API_HOST, apiPath].join("");
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }

    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.Ollama)) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    return [baseUrl, path].join("/");
  }

  extractMessage(res: any) {
    return res.choices?.at(0)?.message?.content ?? "";
  }

  async chat(options: ChatRequest): Promise<ChatResponse> {
    const messages: RequestMessage[] = options.messages.map((v) => ({
      role: v.role,
      content: getMessageTextContent(v),
    }));

    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
      },
    };

    const requestPayload = {
      messages,
      stream: options.config.stream,
      model: modelConfig.model,
      temperature: modelConfig.temperature,
      presence_penalty: modelConfig.presence_penalty,
      frequency_penalty: modelConfig.frequency_penalty,
      top_p: modelConfig.top_p,
      max_tokens: Math.max(modelConfig.max_tokens, 1024),
    };

    console.log("[Request] ollama payload: ", requestPayload);

    const shouldStream = !!options.config.stream;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const chatPath = this.path(Ollama.ChatPath);
      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: getHeaders(),
      };

      // make a fetch request
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      if (shouldStream) {
        let responseText = "";
        let remainText = "";
        let finished = false;

        const finish = () => {
          if (!finished) {
            options.onFinish(responseText);
            finished = true;
          }
        };

        controller.signal.onabort = finish;

        fetchEventSource(chatPath, {
          ...chatPayload,
          async onopen(res) {
            clearTimeout(requestTimeoutId);
            const contentType = res.headers.get("content-type");
            console.log(
              "[Ollama] request response content type: ",
              contentType,
            );

            if (contentType?.startsWith("text/plain")) {
              responseText = await res.clone().text();
              return finish();
            }

            if (
              !res.ok ||
              !res.headers
                .get("content-type")
                ?.startsWith(EventStreamContentType) ||
              res.status !== 200
            ) {
              const responseTexts = [responseText];
              if (res.status === 401) {
                responseTexts.push(Locale.Error.Unauthorized);
              }

              let extraInfo = await res.clone().text();
              try {
                const resJson = await res.clone().json();
                extraInfo = prettyObject(resJson);
              } catch {}

              responseTexts.push(extraInfo);

              responseText = responseTexts.join("\n\n");

              return finish();
            }
          },
          onmessage(msg) {
            if (msg.data === "[DONE]" || finished) {
              return finish();
            }
            const text = msg.data;
            try {
              const json = JSON.parse(text);
              const delta = json.choices?.at(0)?.delta?.content;
              if (delta) {
                responseText += delta;
                options.onUpdate?.(responseText, delta);
              }
            } catch (e) {
              console.error("[Request] parse error", text, msg);
            }
          },
          onclose() {
            finish();
          },
          onerror(e) {
            options.onError?.(e);
            throw e;
          },
          openWhenHidden: true,
        });
      } else {
        const res = await fetch(chatPath, chatPayload);
        clearTimeout(requestTimeoutId);

        const resJson = await res.json();
        const message = this.extractMessage(resJson);
        options.onFinish(message);
      }
    } catch (e) {
      console.log("[Request] failed to make a chat request", e);
      options.onError?.(e as Error);
    }
  }

  async speech(options: SpeechOptions): Promise<ArrayBuffer> {
    // Ollama doesn't support TTS yet, return empty buffer
    throw new Error("Speech synthesis is not supported by Ollama");
  }

  async usage() {
    return {
      used: 0,
      total: 0,
    };
  }

  async models(): Promise<LLMModel[]> {
    if (this.disableListModels) {
      return Promise.resolve([]);
    }

    const res = await fetch(this.path(Ollama.ListModelPath), {
      method: "GET",
      headers: {
        ...getHeaders(),
      },
    });

    const resJson = (await res.json()) as OllamaListModelResponse;
    
    // Convert Ollama format to LLMModel format
    return resJson.models.map((model, index) => ({
      name: model.name,
      available: true,
      provider: {
        id: "ollama",
        providerName: "Ollama", 
        providerType: "ollama",
        sorted: 16,
      },
      sorted: 2000 + index,
    }));
  }
}

export function getHeaders() {
  const accessStore = useAccessStore.getState();
  let headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const makeBearer = (token: string) => `Bearer ${token.trim()}`;
  const validString = (x: string) => x && x.length > 0;

  // when using ollama api in app, not set authorization header
  if (accessStore.useCustomConfig && validString(accessStore.ollamaApiKey)) {
    headers.Authorization = makeBearer(accessStore.ollamaApiKey);
  }

  return headers;
}

export { OllamaApi };
