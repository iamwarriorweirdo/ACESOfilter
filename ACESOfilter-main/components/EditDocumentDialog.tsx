
import React, { useState, useEffect } from 'react';
import { Document, Language } from '../types';
import { TRANSLATIONS } from '../constants';
import { X, FileText, ImageIcon, Eye, FileSpreadsheet, Loader2, Download, FileJson, Copy, Check, RefreshCcw, AlertTriangle, Globe, Monitor } from 'lucide-react';
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

    const t = (TRANSLATIONS as any)[language] || TRANSLATIONS.en;

    const getProxyUrl = (originalUrl: string) => {
        return `/api/proxy?url=${encodeURIComponent(originalUrl.replace('http://', 'https://'))}`;
    };

    useEffect(() => {
        let interval: NodeJS.Timeout;
        let pollCount = 0;
        const MAX_POLLS = 60; // 5 minutes max (5s interval)

        // Chỉ poll khi nội dung có dấu hiệu đang xử lý
        if (isOpen && document && (localContent.includes("Đang xử lý ngầm") || localContent.includes("Đang kích hoạt") || localContent.includes("Đang chờ xử lý"))) {
            interval = setInterval(async () => {
                if (pollCount++ > MAX_POLLS) {
                    clearInterval(interval);
                    setLocalContent("ERROR_DETAILS: Timeout - File processing took too long (>5 min). Please try 'Force Re-Scan'.");
                    return;
                }
                try {
                    const res = await fetch('/api/app?handler=files');
                    const allDocs = (await res.json()) as any[];
                    const freshDoc = allDocs.find((d: any) => d.id === document.id);
                    if (freshDoc && freshDoc.extractedContent && freshDoc.extractedContent !== localContent) {
                        setLocalContent(freshDoc.extractedContent);
                    }
                } catch (e) { }
            }, 5000); // Poll every 5 seconds
        }
        return () => clearInterval(interval);
    }, [isOpen, document, localContent]);

    const forceRescan = async () => {
        if (!document) return;
        setIsProcessing(true);
        try {
            setLocalContent("Đang kích hoạt lại Scan AI (Gemini 3.0)...");
            await fetch('/api/ingest', {
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
            alert("Lỗi kết nối server.");
        } finally { setIsProcessing(false); }
    };

    useEffect(() => {
        if (document && isOpen) {
            setPreviewHtml(null);
            setErrorMsg(null);
            setActiveTab('preview');
            setLocalContent(document.extractedContent || "");

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
                        if (!res.ok) throw new Error(`Tải file thất bại (${res.status}). File có thể quá lớn hoặc link hết hạn.`);
                        const buffer = await res.arrayBuffer();
                        if (isExcel) {
                            const workbook = XLSX.read(buffer, { type: 'array' });
                            setPreviewHtml(XLSX.utils.sheet_to_html(workbook.Sheets[workbook.SheetNames[0]]) || '<p class="text-gray-500">Không có nội dung.</p>');
                        } else {
                            const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
                            const html = result.value?.trim();
                            setPreviewHtml(html || '');
                            if (!html && sizeMB > 20) setErrorMsg('File quá lớn để xem trước. Vui lòng dùng tab "JSON Index (AI)" hoặc tải xuống.');
                        }
                    } catch (e: any) {
                        setErrorMsg(e?.message || 'Không xem trước được.');
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
        // ERROR HANDLING (Raw String or JSON)
        const isRawError = content.startsWith("ERROR_DETAILS:");
        let errorBody = "";

        if (isRawError) {
            errorBody = content;
        } else {
            try {
                const data = JSON.parse(content);
                if (data.full_text_content && data.full_text_content.startsWith("ERROR_DETAILS:")) {
                    errorBody = data.full_text_content;
                }
            } catch (e) { }
        }

        if (errorBody) {
            return (
                <div className="p-6 flex flex-col items-center justify-center text-center space-y-4 h-full">
                    <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center">
                        <AlertTriangle className="text-red-500 w-8 h-8" />
                    </div>
                    <h3 className="text-red-500 font-bold text-lg">Xử lý thất bại</h3>
                    <p className="text-muted-foreground text-sm max-w-md">
                        {errorBody.replace("ERROR_DETAILS:", "").split('\n')[0].trim()}
                    </p>
                    <button onClick={forceRescan} className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-500 rounded-lg text-xs font-bold transition-colors">
                        Thử lại (Retry)
                    </button>
                    <div className="w-full max-w-2xl bg-black/40 rounded-lg border border-red-500/20 overflow-hidden mt-4">
                        <div className="bg-red-500/10 px-4 py-2 border-b border-red-500/20 flex items-center gap-2">
                            <FileText size={14} className="text-red-400" />
                            <span className="text-xs font-bold text-red-300 uppercase">Error Log / Trace</span>
                        </div>
                        <pre className="text-xs text-left p-4 overflow-auto text-red-200/80 font-mono h-32 md:h-48 whitespace-pre-wrap">
                            {errorBody}
                        </pre>
                    </div>
                </div>
            );
        }

        try {
            const data = JSON.parse(content);
            return (
                <div className="space-y-4 p-4 font-mono text-sm">
                    {data.title && (
                        <div className="bg-blue-500/10 p-3 rounded-lg border border-blue-500/20">
                            <div className="text-xs text-blue-400 font-bold uppercase mb-1">Title</div>
                            <div className="text-blue-100 font-bold text-lg">{data.title}</div>
                        </div>
                    )}
                    {data.summary && (
                        <div className="bg-emerald-500/10 p-3 rounded-lg border border-emerald-500/20">
                            <div className="text-xs text-emerald-400 font-bold uppercase mb-1">Summary</div>
                            <div className="text-emerald-100 leading-relaxed">{data.summary}</div>
                        </div>
                    )}
                    {data.key_information && Array.isArray(data.key_information) && (
                        <div className="bg-purple-500/10 p-3 rounded-lg border border-purple-500/20">
                            <div className="text-xs text-purple-400 font-bold uppercase mb-2">Key Information</div>
                            <ul className="list-disc list-inside space-y-1 text-purple-100">
                                {data.key_information.map((item: string, idx: number) => (
                                    <li key={idx}>{item}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                    <div className="bg-gray-800 p-3 rounded-lg border border-gray-700">
                        <div className="text-xs text-gray-400 font-bold uppercase mb-2">Full Content / JSON</div>
                        <pre className="whitespace-pre-wrap text-gray-300 text-xs overflow-x-auto">{JSON.stringify(data, null, 2)}</pre>
                    </div>
                </div>
            );
        } catch (e) {
            // If content is just loading text or raw text (not generic spinner)
            if (content.includes("Đang") || !content.trim().startsWith('{')) {
                return (
                    <div className="flex flex-col h-full bg-[#0d0d0d] text-gray-300 font-mono p-6 overflow-hidden">
                        <div className="flex items-center gap-3 mb-6">
                            <div className="relative">
                                <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse"></div>
                                <div className="absolute inset-0 w-3 h-3 bg-blue-500 rounded-full animate-ping opacity-75"></div>
                            </div>
                            <h3 className="text-lg font-bold text-blue-400">Heuristic Process Monitor</h3>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
                            <div className="p-4 rounded-xl bg-blue-500/5 border border-blue-500/10">
                                <div className="text-xs text-blue-400 uppercase font-bold mb-1">Status</div>
                                <div className="text-white font-bold text-sm">{content.includes("Đang") ? "PROCESSING / QUEUED" : "UNKNOWN STATE"}</div>
                            </div>
                            <div className="p-4 rounded-xl bg-purple-500/5 border border-purple-500/10">
                                <div className="text-xs text-purple-400 uppercase font-bold mb-1">Engine</div>
                                <div className="text-white font-bold text-sm">Gemini 3.0 Flash / Inngest</div>
                            </div>
                            <div className="p-4 rounded-xl bg-emerald-500/5 border border-emerald-500/10">
                                <div className="text-xs text-emerald-400 uppercase font-bold mb-1">Live Update</div>
                                <div className="text-white font-bold text-sm flex items-center gap-2">
                                    <Loader2 size={12} className="animate-spin" /> Polling DB...
                                </div>
                            </div>
                        </div>

                        <div className="flex-1 flex flex-col min-h-0 bg-black rounded-xl border border-white/10 overflow-hidden shadow-inner">
                            <div className="px-4 py-2 bg-white/5 border-b border-white/10 flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <Monitor size={14} className="text-gray-400" />
                                    <span className="text-xs font-bold text-gray-400">SYSTEM LOGS / RAW DB CONTENT</span>
                                </div>
                                <span className="text-[10px] text-gray-600 font-mono">tail -f documents.extracted_content</span>
                            </div>
                            <div className="flex-1 p-4 overflow-auto font-mono text-xs md:text-sm text-green-400/90 leading-relaxed whitespace-pre-wrap">
                                <span className="text-gray-500 mr-2">[{new Date().toLocaleTimeString()}]</span>
                                {content}
                                <span className="inline-block w-2 h-4 bg-green-500/50 ml-1 animate-pulse align-middle"></span>
                            </div>
                        </div>

                        <div className="mt-6 text-center">
                            <p className="text-xs text-muted-foreground mb-3">
                                Process taking too long? use basic OCR or check system health.
                            </p>
                            <button onClick={forceRescan} className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-bold transition-all shadow-lg hover:shadow-blue-500/25 active:scale-95">
                                Force Re-Trigger (Gemini Vision)
                            </button>
                        </div>
                    </div>
                );
            }
            // If not valid JSON, show as text
            return <textarea className="w-full h-full bg-[#111] text-emerald-500 font-mono text-sm p-6 resize-none outline-none border-none leading-relaxed" value={content} readOnly />;
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
                        <div className="flex flex-col h-full">
                            <div className="p-3 border-b border-white/10 bg-black/20 flex gap-3 flex-wrap items-center">
                                <button onClick={forceRescan} disabled={isProcessing} className="flex items-center gap-2 px-4 py-2 border border-purple-500/30 text-purple-400 rounded-lg text-xs font-bold hover:bg-purple-500/10 disabled:opacity-50 transition-colors">
                                    {isProcessing ? <Loader2 className="animate-spin" size={14} /> : <RefreshCcw size={14} />}
                                    Force Re-Scan (Gemini 3.0)
                                </button>
                                {localContent.includes("Đang") && (
                                    <span className="text-xs text-yellow-500 animate-pulse flex items-center gap-2 ml-2">
                                        <Loader2 size={12} className="animate-spin" /> Auto-checking updates...
                                    </span>
                                )}
                                <button
                                    onClick={() => { navigator.clipboard.writeText(localContent || ''); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                                    className="flex items-center gap-2 px-3 py-2 ml-auto hover:bg-white/10 rounded-lg text-xs font-medium text-muted-foreground hover:text-white transition-colors"
                                >
                                    {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy JSON'}
                                </button>
                            </div>
                            <div className="flex-1 overflow-auto bg-[#111]">
                                {renderJsonContent(localContent)}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default EditDocumentDialog;
