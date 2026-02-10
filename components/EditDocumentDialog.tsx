import React, { useState, useEffect, useRef } from 'react';
import { Document, Language } from '../types';
import { TRANSLATIONS } from '../constants';
// Added CheckCircle to fix the 'Cannot find name CheckCircle' error.
import { X, FileText, ImageIcon, Eye, FileSpreadsheet, Loader2, Download, FileJson, AlertTriangle, Globe, Monitor, Terminal, Activity, ChevronRight, Clock, CheckCircle } from 'lucide-react';
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
    const [localContent, setLocalContent] = useState<string>('');
    const [logs, setLogs] = useState<string[]>([]);
    const [timeoutError, setTimeoutError] = useState(false);

    const logContainerRef = useRef<HTMLDivElement>(null);
    const t = (TRANSLATIONS as any)[language] || TRANSLATIONS.en;

    const getProxyUrl = (originalUrl: string, type?: string) => {
        let url = `/api/app?handler=proxy&url=${encodeURIComponent(originalUrl.replace('http://', 'https://'))}`;
        if (type) url += `&contentType=${encodeURIComponent(type)}`;
        return url;
    };

    // CHIẾN LƯỢC: Polling nội dung nếu tệp đang trong quá trình OCR (Inngest)
    useEffect(() => {
        let interval: any;
        let pollCount = 0;
        const MAX_POLLS = 60; 

        if (isOpen) setTimeoutError(false);

        if (logContainerRef.current) {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
        }

        const isStillIndexing = isOpen && document && (!document.extractedContent || document.extractedContent.includes("Đang chờ xử lý") || document.extractedContent.includes("pending"));

        if (isStillIndexing) {
            interval = setInterval(async () => {
                if (pollCount++ > MAX_POLLS) {
                    clearInterval(interval);
                    setTimeoutError(true);
                    return;
                }
                try {
                    const res = await fetch(`/api/app?handler=files&id=${document.id}`);
                    const details = await res.json();
                    if (details.extracted_content && details.extracted_content !== localContent) {
                        setLocalContent(details.extracted_content);
                        if (!details.extracted_content.trim().startsWith('{')) {
                             setLogs(prev => {
                                 const newLine = details.extracted_content;
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

    useEffect(() => {
        if (document && isOpen) {
            setPreviewHtml(null);
            setErrorMsg(null);
            setActiveTab('preview');
            setLocalContent(document.extractedContent || "");
            
            if (document.extractedContent && !document.extractedContent.startsWith('{')) {
                setLogs([document.extractedContent]);
            }

            const name = document.name.toLowerCase();
            const isWord = name.endsWith('.docx') || name.endsWith('.doc');
            const isExcel = name.endsWith('.xlsx') || name.endsWith('.xls');
            
            if (document.type.includes('pdf')) {
                setViewMode('proxy');
            } else if (isWord || isExcel) {
                setViewMode('native');
                setIsProcessing(true);
                const process = async () => {
                    try {
                        const res = await fetch(getProxyUrl(document.content));
                        const buffer = await res.arrayBuffer();
                        if (isExcel) {
                            const workbook = XLSX.read(buffer, { type: 'array' });
                            setPreviewHtml(XLSX.utils.sheet_to_html(workbook.Sheets[workbook.SheetNames[0]]) || '<p>Empty sheet.</p>');
                        } else {
                            const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
                            setPreviewHtml(result.value?.trim() || '');
                        }
                    } catch (e: any) {
                        setErrorMsg(e?.message || 'Preview failed.');
                    } finally { setIsProcessing(false); }
                };
                process();
            } else {
                setViewMode('native');
            }
        }
    }, [document, isOpen]);

    if (!isOpen || !document) return null;

    const renderJsonContent = (content: string) => {
        // Trạng thái LOADING DỮ LIỆU LỚN
        if (!content || content.includes("Đang chờ xử lý")) {
            return (
                <div className="flex flex-col h-full items-center justify-center text-center p-8 bg-[#0d0d0d]">
                    <Loader2 className="w-12 h-12 animate-spin text-primary mb-4" />
                    <h3 className="text-xl font-bold text-white mb-2">Đang tải nội dung...</h3>
                    <p className="text-muted-foreground text-sm max-w-sm">
                        Hệ thống đang truy vấn dữ liệu chi tiết từ máy chủ. Vui lòng đợi trong giây lát.
                    </p>
                </div>
            );
        }

        try {
            const data = JSON.parse(content);
            return (
                <div className="space-y-6 p-6 h-full overflow-y-auto bg-gray-50/5 dark:bg-[#0d0d0d]">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="md:col-span-2 p-5 rounded-2xl bg-gradient-to-br from-blue-500/10 to-blue-600/5 border border-blue-500/20">
                            <div className="text-[10px] font-black uppercase tracking-widest text-blue-400 mb-2">Tiêu đề tài liệu</div>
                            <div className="text-lg md:text-xl font-bold text-blue-100 leading-tight">{data.title || document.name}</div>
                        </div>
                        <div className="p-5 rounded-2xl bg-gradient-to-br from-emerald-500/10 to-emerald-600/5 border border-emerald-500/20 flex flex-col justify-center">
                            <div className="text-[10px] font-black uppercase tracking-widest text-emerald-400 mb-2">Ngôn ngữ</div>
                            <div className="text-2xl font-black text-emerald-100 uppercase">{data.language || "VN"}</div>
                        </div>
                    </div>
                    <div className="p-5 rounded-2xl bg-card border border-border">
                         <div className="flex items-center gap-2 mb-3 pb-3 border-b border-border/50">
                            <Activity size={16} className="text-orange-500" />
                            <span className="text-xs font-bold uppercase">Tóm tắt văn bản</span>
                         </div>
                         <p className="text-sm leading-relaxed">{data.summary || "Nội dung đang được phân tích."}</p>
                    </div>
                    {data.key_information && (
                        <div className="p-5 rounded-2xl bg-card border border-border">
                            <div className="flex items-center gap-2 mb-4"><CheckCircle size={16} className="text-purple-500" /><span className="text-xs font-bold uppercase">Thông tin chính</span></div>
                            <div className="space-y-3">
                                {(Array.isArray(data.key_information) ? data.key_information : []).map((item: string, idx: number) => (
                                    <div key={idx} className="flex gap-3 text-sm text-foreground/80"><div className="w-1.5 h-1.5 rounded-full bg-purple-500 mt-1.5 shrink-0" />{item}</div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            );
        } catch (e) {
            return (
                <div className="p-6 h-full bg-[#0d0d0d] font-mono text-xs text-gray-400 overflow-auto">
                    <div className="flex items-center gap-2 text-emerald-500 mb-4"><Terminal size={14}/> SYSTEM LOGS</div>
                    {logs.map((log, i) => <div key={i} className="mb-1">[{new Date().toLocaleTimeString()}] {log}</div>)}
                    <div className="animate-pulse">_</div>
                </div>
            );
        }
    };

    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-md p-2 md:p-6 animate-fade-in">
            <div className="bg-card w-full max-w-6xl h-full md:h-[90vh] rounded-xl border border-border flex flex-col shadow-2xl overflow-hidden">
                <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-muted/20">
                    <div className="flex items-center gap-3">
                        <FileText size={20} className="text-primary" />
                        <h3 className="font-bold text-sm truncate max-w-xs">{document.name}</h3>
                    </div>
                    <div className="flex gap-2">
                        <button onClick={() => setActiveTab('preview')} className={`px-4 py-1.5 rounded-lg text-xs font-bold ${activeTab === 'preview' ? 'bg-primary text-white' : 'text-muted-foreground'}`}>Preview</button>
                        <button onClick={() => setActiveTab('extracted')} className={`px-4 py-1.5 rounded-lg text-xs font-bold ${activeTab === 'extracted' ? 'bg-emerald-500 text-white' : 'text-muted-foreground'}`}>JSON Index</button>
                        <button onClick={onClose} className="p-2 hover:bg-muted rounded-lg"><X size={20}/></button>
                    </div>
                </div>
                <div className="flex-1 overflow-hidden relative bg-[#0f0f11]">
                    {activeTab === 'preview' ? (
                        <div className={`w-full h-full ${viewMode === 'native' ? 'overflow-y-auto bg-white' : ''}`}>
                            {viewMode === 'proxy' && <iframe src={getProxyUrl(document.content, document.type)} className="w-full h-full border-0" />}
                            {viewMode === 'google' && <iframe src={`https://docs.google.com/gview?url=${encodeURIComponent(document.content)}&embedded=true`} className="w-full h-full border-0" />}
                            {viewMode === 'native' && (
                                <div className="p-8 w-full max-w-4xl mx-auto bg-white text-black min-h-full prose" dangerouslySetInnerHTML={{ __html: previewHtml || '' }} />
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