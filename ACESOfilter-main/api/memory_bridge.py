import sys
import argparse
import json
import asyncio
from datetime import datetime
from neural_memory.cli._helpers import get_config, get_storage
from neural_memory.engine.encoder import MemoryEncoder
from neural_memory.engine.retrieval import ReflexPipeline, DepthLevel

async def run_remember(text):
    config = get_config()
    storage = await get_storage(config)
    
    # Identify current brain
    brain_id = getattr(storage, "_current_brain_id", config.current_brain)
    brain = await storage.get_brain(brain_id)
    if not brain:
        return {"error": "No brain configured. Run 'nmem init' first."}
    
    encoder = MemoryEncoder(storage, brain.config)
    
    # Encode and store
    storage.disable_auto_save()
    result = await encoder.encode(
        content=text,
        timestamp=datetime.now()
    )
    await storage.batch_save()
    
    return {
        "status": "success", 
        "fiber_id": result.fiber.id,
        "content_preview": text[:50]
    }

async def run_recall(query, limit=3):
    config = get_config()
    storage = await get_storage(config)
    
    brain_id = getattr(storage, "_current_brain_id", config.current_brain)
    brain = await storage.get_brain(brain_id)
    if not brain:
        return {"error": "No brain configured"}
    
    pipeline = ReflexPipeline(storage, brain.config)
    
    # Query the reflex pipeline
    result = await pipeline.query(
        query=query,
        depth=DepthLevel.CONTEXT,
        max_tokens=500,
        reference_time=datetime.now()
    )
    
    return {
        "answer": result.context or "",
        "confidence": result.confidence,
        "fibers_matched": result.fibers_matched
    }

def main():
    parser = argparse.ArgumentParser(description="Neural Memory Bridge for ACESOfilter")
    parser.add_argument("--action", choices=["recall", "remember"], required=True)
    parser.add_argument("--query", type=str)
    parser.add_argument("--text", type=str)
    parser.add_argument("--limit", type=int, default=3)
    
    args = parser.parse_args()

    try:
        if args.action == "recall":
            if not args.query:
                print(json.dumps({"error": "Query required for recall"}))
                return
            res = asyncio.run(run_recall(args.query, args.limit))
            print(json.dumps(res))

        elif args.action == "remember":
            if not args.text:
                print(json.dumps({"error": "Text required for remember"}))
                return
            res = asyncio.run(run_remember(args.text))
            print(json.dumps(res))

    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    main()
