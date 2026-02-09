
import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# Mock handler replace neural-memory to reduce deployment size
class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Handle Recall Request (Mock)
        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        # Return empty context so the chat continues without error
        response = {"answer": "", "confidence": 0.0, "message": "Memory module disabled for optimization"}
        self.wfile.write(json.dumps(response).encode())

    def do_POST(self):
        # Handle Remember/Init Request (Mock)
        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        response = {"status": "success", "message": "Memory action acknowledged (Mock mode)"}
        self.wfile.write(json.dumps(response).encode())
