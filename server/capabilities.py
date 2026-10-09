"""Model capabilities detection and context parameter caching for Shell:B."""
import time
from typing import Any


import providers

_caps_cache: dict[str, tuple[float, dict[str, Any]]] = {}


async def model_info(model: str) -> dict[str, Any]:
    """Retrieve capabilities and context limits for a model (cached for 10 minutes)."""
    if providers.is_cloud(model):
        return providers.model_info(model)
    hit = _caps_cache.get(model)
    if hit and time.time() - hit[0] < 600:
        return hit[1]
    import fleet
    r = await fleet.post("/api/show", {"model": model}, timeout=30, light=True)  # a model only a fleet machine has works too
    r.raise_for_status()
    d = r.json()
    num_ctx = 0
    for line in (d.get("parameters") or "").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] == "num_ctx":
            num_ctx = int(parts[1])
    arch = (d.get("model_info") or {}).get("general.architecture", "")
    native_ctx = (d.get("model_info") or {}).get(f"{arch}.context_length", 0)
    info = {
        "capabilities": d.get("capabilities", []),
        "numCtx": num_ctx,
        "nativeCtx": native_ctx,
        "family": (d.get("details") or {}).get("family", ""),
        "parameterSize": (d.get("details") or {}).get("parameter_size", ""),
        "quantization": (d.get("details") or {}).get("quantization_level", "")
    }
    _caps_cache[model] = (time.time(), info)
    return info


def think_param(effort: str, info: dict, model: str):
    """Determine thinking parameter based on model capabilities and requested effort level."""
    if "thinking" not in info["capabilities"]:
        return None
    if "gpt-oss" in model or info.get("family") == "gptoss":
        return {"off": "low", "low": "low", "medium": "medium", "high": "high"}.get(effort, "medium")
    return effort in ("medium", "high")
