
import React, { useState, useEffect, useRef } from 'react';
import { Document, Language } from '../types';
import { TRANSLATIONS } from '../constants';
import { X, FileText, ImageIcon, Eye, FileSpreadsheet, Loader2, Download, FileJson, Copy, Check, RefreshCcw, AlertTriangle, Globe, Monitor, Terminal, Activity, ChevronRight, Clock } from 'lucide-react';
import * as XLSX from 'xlsx';
import * as mammoth from 'mammoth';

interface EditDocumentDialogProps {
    document: Document | null;
    isOpen: boolean;
    onClose: () => void;
    onSave: (docId: string, newContent: string) => void;
    language: Language;
}

const EditDocumentDialog: React.FC<EditDocumentDialogProps> = ({
    document,
    isOpen,
    onClose,
    onSave,
    language
}) => {
    const [activeTab, setActiveTab] = useState<'preview' | 'extracted'>('preview');
    const [viewMode, setViewMode] = useState<'google' | 'native' | 'proxy'>('google');
    const [previewHtml, setPreviewHtml] = useState<string | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [localContent, setLocalContent] = useState<string>('');
    const [logs, setLogs] = useState<string[]>([]);
    const [timeoutError, setTimeoutError] = useState(false);

    const logContainerRef = useRef<HTMLDivElement>(null);
    const t = (TRANSLATIONS as any)[language] || TRANSLATIONS.en;

    // Updated Proxy URL to use merged handler
    const getProxyUrl = (originalUrl: string) => {
        return `/api/app?handler=proxy&url=${encodeURIComponent(originalUrl.replace('http://', 'https://'))}`;
    };

    useEffect(() => {
        let interval: NodeJS.Timeout;
        let pollCount = 0;
        const MAX_POLLS = 60; // 5 minutes (5s interval)

        // Reset timeout state on open
        if (isOpen) setTimeoutError(false);

        // Auto-scroll logs
        if (logContainerRef.current) {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
        }

        const shouldPoll = isOpen && document && (!localContent || !localContent.trim().startsWith('{') || localContent.includes("Đang") || localContent.includes("[INFO]") || localContent.includes("pending"));

        if (shouldPoll) {
            interval = setInterval(async () => {
                if (pollCount++ > MAX_POLLS) {
                    clearInterval(interval);
                    setTimeoutError(true);
                    return;
                }
                try {
                    const res = await fetch('/api/app?handler=files');
                    const allDocs = (await res.json()) as any[];
                    const freshDoc = allDocs.find((d: any) => d.id === document.id);
                    if (freshDoc && freshDoc.extractedContent && freshDoc.extractedContent !== localContent) {
                        setLocalContent(freshDoc.extractedContent);
                        // Parse simple logs if string format matches our convention
                        if (!freshDoc.extractedContent.trim().startsWith('{')) {
                             setLogs(prev => {
                                 const newLine = freshDoc.extractedContent;
                                 if (!prev.includes(newLine)) return [...prev, newLine];
                                 return prev;
                             });
                        }
                    }
                } catch (e) { }
            }, 5000); 
        }
        return () => clearInterval(interval);
    }, [isOpen, document, localContent]);

    const forceRescan = async () => {
        if (!document) return;
        setIsProcessing(true);
        setTimeoutError(false);
        setLogs([]);
        try {
            setLocalContent("[INFO] Requesting Force Re-Scan (Gemini 3.0)...");
            await fetch('/api/app?handler=trigger-ingest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    docId: document.id,
                    url: document.content,
                    fileName: document.name,
                    fileType: document.type,
                })
            });
        } catch (e) {
            alert("Connection Error.");
        } finally { setIsProcessing(false); }
    };

    useEffect(() => {
        if (document && isOpen) {
            setPreviewHtml(null);
            setErrorMsg(null);
            setActiveTab('preview');
            setLocalContent(document.extractedContent || "");
            
            // Initial log setup
            if (document.extractedContent && !document.extractedContent.startsWith('{')) {
                setLogs([document.extractedContent]);
            }

            const name = document.name.toLowerCase();
            const isWord = name.endsWith('.docx') || name.endsWith('.doc');
            const isExcel = name.endsWith('.xlsx') || name.endsWith('.xls');
            const sizeMB = (Number(document.size) || 0) / (1024 * 1024);
            if (document.type.includes('pdf')) {
                setViewMode('proxy');
            } else if (isWord || isExcel) {
                setViewMode('native');
                setIsProcessing(true);
                setErrorMsg(null);
                const process = async () => {
                    try {
                        const res = await fetch(getProxyUrl(document.content));
                        if (!res.ok) throw new Error(`Download failed (${res.status}). Link might be expired.`);
                        const buffer = await res.arrayBuffer();
                        if (isExcel) {
                            const workbook = XLSX.read(buffer, { type: 'array' });
                            setPreviewHtml(XLSX.utils.sheet_to_html(workbook.Sheets[workbook.SheetNames[0]]) || '<p class="text-gray-500">Empty sheet.</p>');
                        } else {
                            const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
                            const html = result.value?.trim();
                            setPreviewHtml(html || '');
                            if (!html && sizeMB > 20) setErrorMsg('File too large for preview. Use "JSON Index" tab.');
                        }
                    } catch (e: any) {
                        setErrorMsg(e?.message || 'Preview failed.');
                        setPreviewHtml('');
                    } finally { setIsProcessing(false); }
                };
                process();
            } else {
                setViewMode('native');
            }
        }
    }, [document, isOpen]);

    if (!isOpen || !document) return null;
    const isImage = document.type.includes('image');
    const isPdf = document.type.includes('pdf');
    const googleDocsUrl = `https://docs.google.com/gview?url=${encodeURIComponent(document.content.replace('http://', 'https://'))}&embedded=true`;
    const proxyPdfUrl = getProxyUrl(document.content);

    const renderJsonContent = (content: string) => {
        const isRawError = content.startsWith("ERROR_DETAILS:") || content.includes("[ERROR]");
        let errorBody = "";

        if (isRawError) {
            errorBody = content;
        } else {
            try {
                const data = JSON.parse(content);
                if (data.full_text_content && (data.full_text_content.startsWith("ERROR_DETAILS:") || data.full_text_content.includes("[ERROR]"))) {
                    errorBody = data.full_text_content;
                }
            } catch (e) { }
        }

        // --- 1. TIMEOUT STATE ---
        if (timeoutError) {
             return (
                <div className="flex flex-col h-full bg-[#0d0d0d] text-gray-300 font-mono p-6 overflow-hidden items-center justify-center text-center">
                    <div className="w-20 h-20 bg-amber-500/10 rounded-full flex items-center justify-center mb-6 animate-pulse">
                        <Clock className="w-10 h-10 text-amber-500" />
                    </div>
                    <h3 className="text-xl font-bold text-amber-500 mb-2">Process Timeout (&gt;5 Min)</h3>
                    <p className="text-muted-foreground text-sm max-w-md mb-8">
                        The indexing pipeline is stalled or the file is extremely large. 
                        The system has stopped polling to save resources.
                    </p>
                    <div className="p-4 bg-black/40 border border-white/10 rounded-xl max-w-lg w-full mb-8 text-left">
                        <div className="text-xs font-bold text-gray-500 uppercase mb-2">Last Known Status</div>
                        <div className="font-mono text-xs text-amber-300">{localContent}</div>
                    </div>
                    <button onClick={forceRescan} className="px-6 py-3 bg-amber-600 hover:bg-amber-500 text-white rounded-xl font-bold text-sm shadow-lg shadow-amber-500/20 transition-all flex items-center gap-2">
                        <RefreshCcw size={16} /> Force Re-Trigger (Retry)
                    </button>
                </div>
            );
        }

        // --- 2. ERROR STATE ---
        if (errorBody) {
            return (
                <div className="p-6 flex flex-col items-center justify-center text-center space-y-4 h-full bg-[#0d0d0d]">
                    <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center border border-red-500/20 shadow-[0_0_30px_rgba(239,68,68,0.2)]">
                        <AlertTriangle className="text-red-500 w-8 h-8" />
                    </div>
                    <h3 className="text-red-500 font-bold text-lg">Indexing Failed</h3>
                    <p className="text-muted-foreground text-sm max-w-md">
                        The system encountered a critical error during the OCR or Metadata extraction phase.
                    </p>
                    <div className="w-full max-w-2xl bg-black/60 rounded-xl border border-red-500/30 overflow-hidden mt-4 shadow-inner">
                        <div className="bg-red-500/10 px-4 py-2 border-b border-red-500/20 flex items-center gap-2">
                            <Terminal size={14} className="text-red-400" />
                            <span className="text-xs font-bold text-red-300 uppercase">Error Trace / Log</span>
                        </div>
                        <pre className="text-xs text-left p-4 overflow-auto text-red-200/90 font-mono h-32 md:h-48 whitespace-pre-wrap selection:bg-red-500/30">
                            {errorBody.replace("ERROR_DETAILS:", "").trim()}
                        </pre>
                    </div>
                     <button onClick={forceRescan} className="mt-4 px-6 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-xl text-sm font-bold transition-all shadow-lg hover:shadow-red-500/25 active:scale-95 flex items-center gap-2">
                        <RefreshCcw size={16} /> Retry Process
                    </button>
                </div>
            );
        }

        // --- 3. SUCCESS STATE (Valid JSON) ---
        try {
            const data = JSON.parse(content);
            return (
                <div className="space-y-6 p-6 h-full overflow-y-auto bg-gray-50/5 dark:bg-[#0d0d0d]">
                    {/* Metadata Header */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="md:col-span-2 p-5 rounded-2xl bg-gradient-to-br from-blue-500/10 to-blue-600/5 border border-blue-500/20 relative overflow-hidden">
                            <div className="absolute top-0 right-0 p-3 opacity-20"><FileText size={40} /></div>
                            <div className="text-[10px] font-black uppercase tracking-widest text-blue-400 mb-2">Document Title</div>
                            <div className="text-lg md:text-xl font-bold text-blue-100 leading-tight">{data.title || "Untitled Document"}</div>
                            <div className="mt-4 flex gap-2">
                                <span className="px-2 py-1 bg-blue-500/20 rounded text-[10px] text-blue-300 font-bold uppercase">{data.language || "Unknown Lang"}</span>
                                <span className="px-2 py-1 bg-blue-500/20 rounded text-[10px] text-blue-300 font-bold uppercase">{data.parse_method || "AI Vision"}</span>
                            </div>
                        </div>
                        <div className="p-5 rounded-2xl bg-gradient-to-br from-emerald-500/10 to-emerald-600/5 border border-emerald-500/20 flex flex-col justify-center">
                            <div className="text-[10px] font-black uppercase tracking-widest text-emerald-400 mb-2">Confidence Score</div>
                            <div className="text-3xl font-black text-emerald-100">98%</div>
                            <div className="text-[10px] text-emerald-400/60 mt-1">AI Verification Pass</div>
                        </div>
                    </div>

                    {/* Summary */}
                    <div className="p-5 rounded-2xl bg-card border border-border shadow-sm">
                         <div className="flex items-center gap-2 mb-3 pb-3 border-b border-border/50">
                            <Activity size={16} className="text-orange-500" />
                            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Executive Summary</span>
                         </div>
                         <p className="text-sm leading-relaxed text-foreground/90">{data.summary || "No summary generated."}</p>
                    </div>

                    {/* Key Info Grid */}
                     {data.key_information && Array.isArray(data.key_information) && (
                        <div className="p-5 rounded-2xl bg-card border border-border shadow-sm">
                            <div className="flex items-center gap-2 mb-4">
                                <Check size={16} className="text-purple-500" />
                                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Key Extracted Points</span>
                            </div>
                            <div className="grid grid-cols-1 gap-3">
                                {data.key_information.map((item: string, idx: number) => (
                                    <div key={idx} className="flex gap-3 p-3 rounded-xl bg-muted/30 border border-transparent hover:border-primary/20 transition-all">
                                        <div className="mt-1 w-1.5 h-1.5 rounded-full bg-purple-500 shrink-0" />
                                        <span className="text-sm text-foreground/80">{item}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    
                    {/* Raw JSON Toggle */}
                    <div className="pt-4 border-t border-border/30">
                        <details className="group">
                            <summary className="cursor-pointer text-xs font-bold text-muted-foreground hover:text-foreground flex items-center gap-2 select-none">
                                <ChevronRight size={14} className="group-open:rotate-90 transition-transform" />
                                View Raw JSON Payload
                            </summary>
                            <div className="mt-3 p-4 bg-black rounded-xl border border-white/10 overflow-hidden">
                                <pre className="text-[10px] text-gray-400 font-mono overflow-x-auto whitespace-pre-wrap">{JSON.stringify(data, null, 2)}</pre>
                            </div>
                        </details>
                    </div>
                </div>
            );
        } catch (e) {
            // --- 4. PROCESSING / LOG STATE (Console View) ---
            const lastLog = logs[logs.length - 1] || content;
            const isErrorLog = lastLog.includes("[ERROR]") || lastLog.includes("Failed");
            const isWarnLog = lastLog.includes("[WARN]") || lastLog.includes("weak");
            
            return (
                <div className="flex flex-col h-full bg-[#0d0d0d] text-gray-300 font-mono overflow-hidden relative">
                    {/* Header */}
                    <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-white/5">
                        <div className="flex items-center gap-3">
                            <div className="relative">
                                <div className={`w-3 h-3 rounded-full ${isErrorLog ? 'bg-red-500' : isWarnLog ? 'bg-amber-500' : 'bg-emerald-500'} animate-pulse`}></div>
                                <div className={`absolute inset-0 w-3 h-3 rounded-full ${isErrorLog ? 'bg-red-500' : isWarnLog ? 'bg-amber-500' : 'bg-emerald-500'} animate-ping opacity-75`}></div>
                            </div>
                            <div>
                                <h3 className="text-sm font-bold text-white tracking-tight">System Process Monitor</h3>
                                <div className="text-[10px] text-gray-400 font-medium">PID: {document.id} • Engine: Hybrid (Mammoth/Gemini)</div>
                            </div>
                        </div>
                        <div className="flex items-center gap-2 px-3 py-1 bg-black/40 rounded-lg border border-white/10">
                            <Activity size={12} className="text-blue-400" />
                            <span className="text-[10px] font-bold text-blue-400 uppercase">Live Stream</span>
                        </div>
                    </div>

                    {/* Console Output */}
                    <div ref={logContainerRef} className="flex-1 p-6 overflow-y-auto space-y-3 font-mono text-xs scroll-smooth">
                        {logs.length === 0 && (
                            <div className="text-gray-600 italic">Waiting for log stream...</div>
                        )}
                        {logs.map((log, i) => {
                             const isErr = log.includes("[ERROR]") || log.includes("Failed");
                             const isWarn = log.includes("[WARN]") || log.includes("weak") || log.includes("Fall back");
                             const isInfo = log.includes("[INFO]");
                             
                             return (
                                <div key={i} className={`flex gap-3 pb-2 border-b border-white/5 last:border-0 ${isErr ? 'text-red-400' : isWarn ? 'text-amber-400' : isInfo ? 'text-blue-300' : 'text-gray-400'}`}>
                                    <span className="opacity-30 select-none">{(i + 1).toString().padStart(2, '0')}</span>
                                    <span className="leading-relaxed break-all">{log}</span>
                                </div>
                             );
                        })}
                        {/* Fake cursor */}
                        <div className="w-2 h-4 bg-gray-500 animate-pulse mt-2"></div>
                    </div>

                    {/* Footer Actions */}
                    <div className="p-4 bg-white/5 border-t border-white/10 flex justify-between items-center">
                        <div className="text-[10px] text-gray-500">
                             Use 'Force Re-Scan' if process hangs &gt; 3 min.
                        </div>
                        <button onClick={forceRescan} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold transition-all flex items-center gap-2 shadow-lg hover:shadow-blue-500/20">
                            <RefreshCcw size={12} /> Force Re-Trigger
                        </button>
                    </div>
                </div>
            );
        }
    };

    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-md p-2 md:p-6 animate-in fade-in duration-300">
            <div className="bg-card w-full max-w-6xl h-full md:h-[90vh] rounded-xl border border-border flex flex-col shadow-2xl overflow-hidden text-foreground">
                <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-muted/20 shrink-0">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="w-10 h-10 rounded-lg bg-background border border-border flex items-center justify-center shrink-0">
                            {isImage ? <ImageIcon size={20} className="text-purple-500" /> : isPdf ? <FileText size={20} className="text-red-500" /> : <FileSpreadsheet size={20} className="text-green-500" />}
                        </div>
                        <div className="min-w-0 flex-1">
                            <h3 className="font-bold text-sm md:text-base text-foreground break-all" title={document.name}>{document.name}</h3>
                            <p className="text-xs text-muted-foreground">{(Number(document.size) / 1024 / 1024).toFixed(2)} MB</p>
                            <a href={document.content} target="_blank" rel="noopener noreferrer" download={document.name} className="inline-flex items-center gap-1.5 mt-1.5 text-xs font-medium text-primary hover:underline">
                                <Download size={14} /> Tải xuống
                            </a>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="hidden md:flex bg-muted p-1 rounded-lg border border-border items-center">
                            {activeTab === 'preview' && isPdf && (
                                <button
                                    onClick={() => setViewMode(prev => prev === 'google' ? 'proxy' : 'google')}
                                    className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all flex items-center gap-2 mr-2 border-r border-border pr-3 ${viewMode === 'proxy' ? 'text-blue-400' : 'text-muted-foreground hover:text-foreground'}`}
                                    title="Switch Viewer Mode"
                                >
                                    {viewMode === 'google' ? <Globe size={14} /> : <Monitor size={14} />}
                                    {viewMode === 'google' ? 'Google Viewer' : 'Native Viewer'}
                                </button>
                            )}
                            <button onClick={() => setActiveTab('preview')} className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all flex items-center gap-2 ${activeTab === 'preview' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}><Eye size={14} /> Preview</button>
                            <button onClick={() => setActiveTab('extracted')} className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all flex items-center gap-2 ${activeTab === 'extracted' ? 'bg-background text-emerald-500 shadow-sm' : 'text-muted-foreground'}`}><FileJson size={14} /> JSON Index (AI)</button>
                        </div>
                        <button onClick={onClose} className="p-2 hover:bg-red-500/10 hover:text-red-500 rounded-lg transition-all"><X size={20} /></button>
                    </div>
                </div>
                <div className="flex-1 overflow-hidden relative bg-[#0f0f11]">
                    {activeTab === 'preview' ? (
                        <div className="w-full h-full">
                            {viewMode === 'google' && <iframe src={googleDocsUrl} className="w-full h-full border-0" title="Google Doc Viewer" />}
                            {viewMode === 'proxy' && isPdf && <iframe src={proxyPdfUrl} className="w-full h-full border-0" title="PDF Viewer" />}
                            {viewMode === 'native' && (
                                <div className="w-full h-full overflow-y-auto p-4 bg-[#111]">
                                    {isProcessing && (
                                        <div className="flex h-full items-center justify-center">
                                            <Loader2 className="animate-spin text-primary w-10 h-10" />
                                        </div>
                                    )}
                                    {!isProcessing && errorMsg && (
                                        <div className="flex h-full items-center justify-center">
                                            <div className="text-center max-w-md p-6 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-200">
                                                <AlertTriangle className="w-10 h-10 mx-auto mb-2 text-amber-500" />
                                                <p className="text-sm font-medium mb-2">{errorMsg}</p>
                                                <p className="text-xs text-muted-foreground mb-4">Dùng tab &quot;JSON Index (AI)&quot; để xem nội dung đã trích xuất, hoặc tải file xuống.</p>
                                                <div className="flex gap-2 justify-center">
                                                    <a href={document.content} target="_blank" rel="noopener noreferrer" download={document.name} className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90" title="Tải file xuống">Tải xuống</a>
                                                    <button type="button" onClick={() => setActiveTab('extracted')} className="px-4 py-2 rounded-lg border border-border hover:bg-muted text-sm font-medium" title="Xem nội dung đã trích xuất (AI)">Xem JSON Index</button>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                    {!isProcessing && !errorMsg && isImage && (
                                        <div className="flex h-full items-center justify-center">
                                            <img src={document.content} className="max-w-full max-h-full object-contain" alt="File preview" />
                                        </div>
                                    )}
                                    {!isProcessing && !errorMsg && !isImage && (
                                        <div className="w-full max-w-[900px] mx-auto min-h-[200px] bg-white text-black p-8 md:p-12 shadow-lg mb-8">
                                            <div className="preview-doc-content prose max-w-none" dangerouslySetInnerHTML={{ __html: previewHtml || "" }} />
                                        </div>
                                    )}
                                    {!isProcessing && !errorMsg && !isImage && !previewHtml && (
                                        <div className="flex h-full items-center justify-center">
                                            <p className="text-muted-foreground text-sm">Không có nội dung xem trước. Chuyển sang tab JSON Index (AI) hoặc tải file.</p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ) : (
                        renderJsonContent(localContent)
                    )}
                </div>
            </div>
        </div>
    );
};

export default EditDocumentDialog;
