import React, { useState } from 'react';
import { BACKEND_FILES } from '../constants';
import { Check, Copy, FileCode, X } from 'lucide-react';

interface BackendViewerProps {
  isOpen: boolean;
  onClose: () => void;
}

const BackendViewer: React.FC<BackendViewerProps> = ({ isOpen, onClose }) => {
  const [activeFile, setActiveFile] = useState(BACKEND_FILES[0]);
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(activeFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-card w-full max-w-5xl h-[85vh] rounded-xl border border-border flex flex-col shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="p-4 border-b border-border flex items-center justify-between bg-muted/30">
          <div>
            <h2 className="text-xl font-bold text-foreground">Next.js + Drizzle Backend Architecture</h2>
            <p className="text-sm text-muted-foreground">Reference implementation for the requested tech stack.</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors">
            <X className="w-6 h-6 text-muted-foreground" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* File List */}
          <div className="w-64 border-r border-border bg-muted/10 flex flex-col overflow-y-auto">
            <div className="p-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Project Files
            </div>
            {BACKEND_FILES.map((file) => (
              <button
                key={file.name}
                onClick={() => setActiveFile(file)}
                className={`flex items-center gap-2 px-4 py-3 text-sm transition-colors ${
                  activeFile.name === file.name
                    ? 'bg-primary/10 text-primary border-r-2 border-primary'
                    : 'text-muted-foreground hover:bg-muted/20 hover:text-foreground'
                }`}
              >
                <FileCode className="w-4 h-4" />
                <div className="text-left">
                  <div className="font-medium truncate">{file.name}</div>
                  <div className="text-xs opacity-60 truncate">{file.path}</div>
                </div>
              </button>
            ))}
          </div>

          {/* Code Editor View */}
          <div className="flex-1 flex flex-col bg-[#0d0d0d]">
            <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-black/40">
              <span className="text-sm font-mono text-muted-foreground">{activeFile.path}</span>
              <button
                onClick={handleCopy}
                className="flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-md hover:bg-white/10 transition-colors text-muted-foreground hover:text-foreground"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy Code'}
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <pre className="font-mono text-sm text-gray-300 leading-relaxed">
                <code>{activeFile.content}</code>
              </pre>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};

export default BackendViewer;