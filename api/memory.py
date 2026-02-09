
import json
from http.server import BaseHTTPRequestHandler
import asyncio
from datetime import datetime
from neural_memory.cli._helpers import get_config, get_storage
from neural_memory.engine.encoder import MemoryEncoder
from neural_memory.engine.retrieval import ReflexPipeline, DepthLevel
from neural_memory.engine.brain import BrainConfig
from urllib.parse import urlparse, parse_qs

async def run_init():
    try:
        config = get_config()
        storage = await get_storage(config)
        
        # Lấy ID brain hiện tại từ config hoặc mặc định
        brain_id = config.current_brain or "aceso_brain_default"
        brain = await storage.get_brain(brain_id)
        
        if not brain:
            # Khởi tạo brain mới nếu chưa tồn tại
            await storage.create_brain(brain_id, BrainConfig())
            return {"status": "success", "message": f"Brain '{brain_id}' đã được khởi tạo thành công."}
        else:
            return {"status": "exists", "message": f"Brain '{brain_id}' đã tồn tại và sẵn sàng."}
    except Exception as e:
        return {"status": "error", "message": str(e)}

async def run_remember(text):
    config = get_config()
    storage = await get_storage(config)
    brain_id = getattr(storage, "_current_brain_id", config.current_brain)
    brain = await storage.get_brain(brain_id)
    if not brain:
        return {"error": "No brain configured. Please run init first."}
    
    encoder = MemoryEncoder(storage, brain.config)
    storage.disable_auto_save()
    result = await encoder.encode(content=text, timestamp=datetime.now())
    await storage.batch_save()
    return {"status": "success", "fiber_id": result.fiber.id}

async def run_recall(query):
    config = get_config()
    storage = await get_storage(config)
    brain_id = getattr(storage, "_current_brain_id", config.current_brain)
    brain = await storage.get_brain(brain_id)
    if not brain:
        return {"error": "No brain configured"}
    
    pipeline = ReflexPipeline(storage, brain.config)
    result = await pipeline.query(query=query, depth=DepthLevel.CONTEXT, max_tokens=500, reference_time=datetime.now())
    return {"answer": result.context or "", "confidence": result.confidence}

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query_params = parse_qs(urlparse(self.path).query)
        action = query_params.get('action', [None])[0]
        q = query_params.get('query', [None])[0]

        if action == 'recall' and q:
            res = asyncio.run(run_recall(q))
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(res).encode())
        else:
            self.send_response(400)
            self.end_headers()

    def do_POST(self):
        content_length = int(self.headers['Content-Length'])
        post_data = json.loads(self.rfile.read(content_length))
        action = post_data.get('action')
        text = post_data.get('text')

        if action == 'init':
            res = asyncio.run(run_init())
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(res).encode())
        elif action == 'remember' and text:
            res = asyncio.run(run_remember(text))
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(res).encode())
        else:
            self.send_response(400)
            self.end_headers()
