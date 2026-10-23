"""agent 用的聊天模型：langchain 的 ChatOpenAI 指向 OpenAI 兼容网关（Kimi），多两件事：

- 保留思考过程：Kimi / DeepSeek 这类思考模型在响应里多一个 reasoning_content，ChatOpenAI 按 OpenAI 规范会丢掉它。
  这里把它放进消息的 additional_kwargs["reasoning_content"]（流式按块拼接），运行时间线里显示为"思考"。
  发回给模型时不带（Kimi 不要求，省 token）
- 和 ModelPool 共用 token 轮换与账号配额排队（model/pool.py 的 http_client）
"""

from __future__ import annotations

from typing import Any

from langchain_openai import ChatOpenAI

from ..config import ModelConfig
from .pool import http_client


class ChatModel(ChatOpenAI):
    def _convert_chunk_to_generation_chunk(self, chunk: dict, default_chunk_class: type,
                                           base_generation_info: dict | None) -> Any:
        gen = super()._convert_chunk_to_generation_chunk(chunk, default_chunk_class, base_generation_info)
        choices = chunk.get("choices") or []
        delta = (choices[0].get("delta") or {}) if choices else {}
        if gen is not None and delta.get("reasoning_content"):
            gen.message.additional_kwargs["reasoning_content"] = delta["reasoning_content"]
        return gen

    def _create_chat_result(self, response: Any, generation_info: dict | None = None) -> Any:
        result = super()._create_chat_result(response, generation_info)
        data = response if isinstance(response, dict) else response.model_dump()
        for gen, choice in zip(result.generations, data.get("choices") or []):
            if text := (choice.get("message") or {}).get("reasoning_content"):
                gen.message.additional_kwargs["reasoning_content"] = text
        return result


def chat_model(cfg: ModelConfig, http: Any = None) -> ChatModel:
    # http_socket_options=()：不让 langchain 给（用不到的）同步客户端换 transport——换了会关掉 HTTPS_PROXY 等代理环境变量
    return ChatModel(model=cfg.name, base_url=cfg.url, api_key=cfg.tokens[0], http_async_client=http or http_client(cfg),
                     http_socket_options=(), max_retries=cfg.max_retries, stream_usage=cfg.stream_usage, timeout=600)
