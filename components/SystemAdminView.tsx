

import { SystemConfig, Language, Document } from '../types';
import { TRANSLATIONS } from '../constants';
import { Server, Activity, Cpu, Save, Settings, Users, Scale, Loader2, Globe, Layers, History, ShieldCheck, BarChart3, TrendingUp, BrainCircuit, CheckCircle, XCircle, DownloadCloud, Zap, Cloud, HardDrive, Terminal, ShieldAlert, FileJson, RefreshCw, Key, Database, ChevronRight, Workflow } from 'lucide-react';
import React, { useState, useEffect } from 'react';

interface SystemAdminViewProps {
    config: SystemConfig;
    setConfig: (config: SystemConfig) => Promise<void> | void;
    documents: Document[];
    language: Language;
    currentUsername: string;
    isEmbedded?: boolean;
}

const SystemAdminView: React.FC<SystemAdminViewProps> = ({ config, setConfig, documents, language, currentUsername, isEmbedded = false }) => {
    const t = (TRANSLATIONS as any)[language] || TRANSLATIONS.en;
    const [localConfig, setLocalConfig] = useState<SystemConfig>(config);
    const [hasChanges, setHasChanges] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isBackingUp, setIsBackingUp] = useState(false);

    useEffect(() => {
        setLocalConfig(config);
    }, [config]);

    const handleLocalChange = (key: keyof SystemConfig, value: any) => {
        setLocalConfig(prev => ({ ...prev, [key]: value }));
        setHasChanges(true);
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            await setConfig(localConfig);
            setHasChanges(false);
        } finally {
            setIsSaving(false);
        }
    };

    // Updated backup handler to point to merged api
    const handleDownloadBackup = async () => {
        setIsBackingUp(true);
        try {
            window.location.href = '/api/app?handler=backup';
        } finally {
            setTimeout(() => setIsBackingUp(false), 2000);
        }
    };

    const totalSizeMB = (documents.reduce((acc, doc) => acc + (Number(doc.size) || 0), 0) / (1024 * 1024)).toFixed(2);
    
    // Giả lập log hệ thống từ trạng thái document
    const systemLogs = documents
        .filter(d => d.extractedContent && (d.extractedContent.includes('ERROR') || d.extractedContent.includes('failed') || d.extractedContent.includes('INFO')))
        .slice(0, 5)
        .map(d => ({
            time: new Date(d.uploadDate).toLocaleTimeString(),
            level: d.status === 'failed' ? 'ERROR' : 'INFO',
            msg: d.extractedContent?.substring(0, 100) || "Process finished"
        }));

    return (
        <div className={isEmbedded ? "h-full w-full bg-background p-6" : "p-8 overflow-y-auto"}>
            <div className="max-w-7xl mx-auto space-y-8 pb-20">
                {/* Status Dashboard */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
                    <StatusCard icon={<Activity className="text-green-500" />} label="Hệ thống" value="Active" sub="Multi-Cloud Failover" borderColor="border-green-500/20" />
                    <StatusCard icon={<Zap className="text-orange-500" />} label="Groq AI" value={process.env.GROQ_API_KEY ? "READY" : "OFF"} sub="Llama-3.3 / Qwen" borderColor="border-orange-500/20" />
                    <StatusCard icon={<Cloud className="text-blue-500" />} label="OpenAI" value={process.env.OPENAI_API_KEY ? "ONLINE" : "CHECK ENV"} sub="GPT-4o Mini (Free Tier)" borderColor="border-blue-500/20" />
                    <StatusCard icon={<Layers className="text-indigo-500" />} label="Dung lượng" value={`${totalSizeMB} MB`} sub="Hybrid DB" borderColor="border-indigo-500/20" />
                    <StatusCard icon={<Cpu className="text-amber-500" />} label="Model chính" value={localConfig.chatModel?.split('-')[0].toUpperCase() || "GEMINI"} sub="Active Engine" borderColor="border-amber-500/20" />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    {/* Left Column: AI & Core Config */}
                    <div className="lg:col-span-2 space-y-8">
                        {/* AI Engine Selection */}
                        <div className="bg-card border border-border rounded-[2rem] p-8 shadow-sm space-y-6">
                            <div className="flex items-center justify-between border-b border-border pb-4">
                                <div className="flex items-center gap-3">
                                    <BrainCircuit className="text-primary" />
                                    <h3 className="text-xl font-bold uppercase tracking-tight">Cấu hình Suy luận AI</h3>
                                </div>
                                {hasChanges && (
                                    <button onClick={handleSave} disabled={isSaving} className="flex items-center gap-2 px-6 py-2 bg-primary text-white rounded-xl text-xs font-black shadow-lg shadow-primary/20 hover:scale-105 active:scale-95 transition-all">
                                        {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                                        LƯU THAY ĐỔI
                                    </button>
                                )}
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <ConfigField label="OCR Strategy (Vision)" sub="Trích xuất chữ từ ảnh/PDF scan (Ưu tiên Vision Models)">
                                    <select 
                                        value={localConfig.ocrModel || 'gemini-3-flash-preview'}
                                        onChange={e => handleLocalChange('ocrModel', e.target.value)}
                                        className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none"
                                    >
                                        <optgroup label="Google Gemini">
                                            <option value="gemini-3-flash-preview">Gemini 3.0 Flash (Recommended)</option>
                                            <option value="gemini-2.0-flash-exp">Gemini 2.0 Flash Exp</option>
                                            <option value="gemini-1.5-flash-latest">Gemini 1.5 Flash (Stable)</option>
                                        </optgroup>
                                        <optgroup label="OpenAI (Free Tier Eligible)">
                                            <option value="gpt-4o-mini">GPT-4o Mini (Vision Capable)</option>
                                        </optgroup>
                                        <optgroup label="Groq / Hugging Face">
                                            <option value="llama-3.2-11b-vision-preview">Groq: Llama 3.2 11B Vision</option>
                                            <option value="llama-3.2-90b-vision-preview">Groq: Llama 3.2 90B Vision</option>
                                            <option value="microsoft/Florence-2-base">HF: Florence-2 (Standard OCR)</option>
                                        </optgroup>
                                    </select>
                                </ConfigField>

                                <ConfigField label="Embedding Model (RAG)" sub="Tạo Vector cho tìm kiếm ngữ nghĩa">
                                    <select 
                                        value={localConfig.embeddingModel || 'text-embedding-004'}
                                        onChange={e => handleLocalChange('embeddingModel', e.target.value)}
                                        className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none"
                                    >
                                        <optgroup label="Google Gemini">
                                            <option value="text-embedding-004">Gemini Text Embedding 004</option>
                                        </optgroup>
                                        <optgroup label="OpenAI">
                                            <option value="text-embedding-3-small">OpenAI Text Embedding 3 Small</option>
                                            <option value="text-embedding-3-large">OpenAI Text Embedding 3 Large</option>
                                        </optgroup>
                                    </select>
                                </ConfigField>

                                <ConfigField label="Analysis Engine" sub="Phân loại và tóm tắt JSON Metadata">
                                    <select 
                                        value={localConfig.analysisModel || 'gemini-3-flash-preview'}
                                        onChange={e => handleLocalChange('analysisModel', e.target.value)}
                                        className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none"
                                    >
                                        <option value="gemini-3-flash-preview">Gemini 3.0 Flash</option>
                                        <option value="gemini-1.5-flash-latest">Gemini 1.5 Flash</option>
                                        <option value="gpt-4o-mini">OpenAI GPT-4o Mini</option>
                                        <option value="llama-3.3-70b-versatile">Groq Llama 3.3 70B (Fast JSON)</option>
                                        <option value="mixtral-8x7b-32768">Groq Mixtral 8x7B</option>
                                    </select>
                                </ConfigField>

                                <ConfigField label="Chat RAG Interface" sub="Model tương tác chính với người dùng">
                                    <select 
                                        value={localConfig.chatModel || 'gemini-3-flash-preview'}
                                        onChange={e => handleLocalChange('chatModel', e.target.value)}
                                        className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none"
                                    >
                                        <optgroup label="Google Gemini">
                                            <option value="gemini-3-flash-preview">Gemini 3.0 Flash</option>
                                            <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite</option>
                                            <option value="gemini-2.0-flash-exp">Gemini 2.0 Flash Exp</option>
                                            <option value="gemini-1.5-flash-latest">Gemini 1.5 Flash (Backup)</option>
                                        </optgroup>
                                        <optgroup label="Groq (High Speed)">
                                            <option value="llama-3.3-70b-versatile">Llama 3.3 70B Versatile</option>
                                            <option value="llama-3.1-8b-instant">Llama 3.1 8B Instant</option>
                                            <option value="qwen-2.5-32b">Qwen 2.5 32B</option>
                                            <option value="gemma2-9b-it">Gemma 2 9B IT</option>
                                        </optgroup>
                                        <optgroup label="OpenAI">
                                            <option value="gpt-4o-mini">GPT-4o Mini (Best Cost/Perf)</option>
                                            <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
                                        </optgroup>
                                    </select>
                                </ConfigField>
                            </div>
                        </div>

                        {/* External APIs Integration */}
                        <div className="bg-card border border-border rounded-[2rem] p-8 shadow-sm space-y-6">
                            <div className="flex items-center justify-between border-b border-border pb-4">
                                <div className="flex items-center gap-3">
                                    <Key className="text-orange-500" />
                                    <h3 className="text-xl font-bold uppercase tracking-tight">API & Keys Configuration</h3>
                                </div>
                            </div>
                            
                            <div className="space-y-4">
                                <p className="text-xs text-muted-foreground italic bg-muted/30 p-3 rounded-lg border border-border">
                                    Lưu ý: Các API Key dưới đây sẽ được lưu vào biến môi trường hệ thống. Nếu bạn đã thiết lập trong Vercel Environment Variables, không cần điền vào đây.
                                </p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
                                    <ConfigField label="Adobe Client ID" sub="Dùng để nén PDF (Tùy chọn)">
                                        <input 
                                            type="password"
                                            value={localConfig.adobeClientId || ''}
                                            onChange={e => handleLocalChange('adobeClientId', e.target.value)}
                                            className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm font-mono outline-none"
                                            placeholder={process.env.ADOBE_CLIENT_ID ? "•••• (Set in Env)" : "Enter Client ID"}
                                        />
                                    </ConfigField>
                                    <ConfigField label="OpenAI API Key" sub="Dùng cho GPT-4o Mini / Embeddings">
                                        <input 
                                            type="password"
                                            onChange={e => {/* Logic to save this securely would go here, currently UI only */}}
                                            className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm font-mono outline-none"
                                            placeholder={process.env.OPENAI_API_KEY ? "•••••••• (Active)" : "sk-..."}
                                            disabled={true} 
                                        />
                                        <div className="text-[10px] text-blue-500 mt-1">* Vui lòng set OPENAI_API_KEY trong Vercel Dashboard để bảo mật.</div>
                                    </ConfigField>
                                </div>
                                <div className="flex items-center gap-3">
                                    <label className="relative inline-flex items-center cursor-pointer">
                                        <input 
                                            type="checkbox" 
                                            className="sr-only peer" 
                                            checked={!!localConfig.enableAdobeCompression}
                                            onChange={e => handleLocalChange('enableAdobeCompression', e.target.checked)}
                                        />
                                        <div className="w-11 h-6 bg-muted peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
                                        <span className="ml-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Kích hoạt Tối ưu hóa Adobe</span>
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Right Column: Maintenance & Logs */}
                    <div className="space-y-8">
                        {/* Data Management */}
                        <div className="bg-card border border-border rounded-[2rem] p-8 shadow-sm space-y-6">
                            <h3 className="text-sm font-black uppercase tracking-widest text-muted-foreground border-b border-border pb-4 flex items-center gap-2">
                                <Database size={16} /> {t.dbManagement}
                            </h3>
                            <div className="space-y-3">
                                <button onClick={handleDownloadBackup} disabled={isBackingUp} className="w-full flex items-center justify-between p-4 rounded-2xl bg-muted/30 hover:bg-primary/10 border border-border hover:border-primary/20 transition-all group">
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 rounded-lg bg-background border border-border group-hover:bg-primary group-hover:text-white transition-all">
                                            {isBackingUp ? <Loader2 size={16} className="animate-spin" /> : <FileJson size={16} />}
                                        </div>
                                        <div className="text-left">
                                            <div className="text-xs font-bold">{t.backupData}</div>
                                            <div className="text-[10px] text-muted-foreground">Download JSON local backup</div>
                                        </div>
                                    </div>
                                    <DownloadCloud size={16} className="text-muted-foreground" />
                                </button>

                                <button onClick={() => alert("Chức năng đồng bộ đang được kích hoạt...")} className="w-full flex items-center justify-between p-4 rounded-2xl bg-muted/30 hover:bg-emerald-500/10 border border-border hover:border-emerald-500/20 transition-all group">
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 rounded-lg bg-background border border-border group-hover:bg-emerald-500 group-hover:text-white transition-all">
                                            <RefreshCw size={16} />
                                        </div>
                                        <div className="text-left">
                                            <div className="text-xs font-bold">Đồng bộ Database</div>
                                            <div className="text-[10px] text-muted-foreground">Dọn dẹp Vector & Metadata</div>
                                        </div>
                                    </div>
                                    <ChevronRight size={16} className="text-muted-foreground" />
                                </button>
                            </div>
                        </div>

                        {/* System Logs */}
                        <div className="bg-[#0d0d0d] border border-white/5 rounded-[2rem] overflow-hidden shadow-2xl flex flex-col h-[400px]">
                            <div className="px-6 py-4 border-b border-white/5 bg-white/5 flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <Terminal size={14} className="text-emerald-500" />
                                    <span className="text-[10px] font-black uppercase tracking-widest text-emerald-500">System Logs</span>
                                </div>
                                <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
                            </div>
                            <div className="flex-1 p-4 font-mono text-[10px] overflow-y-auto space-y-2 custom-scrollbar">
                                {systemLogs.length === 0 ? (
                                    <div className="text-gray-600 italic">No recent anomalies detected...</div>
                                ) : (
                                    systemLogs.map((log, i) => (
                                        <div key={i} className={`flex gap-3 leading-relaxed ${log.level === 'ERROR' ? 'text-red-400' : 'text-gray-400'}`}>
                                            <span className="opacity-30">[{log.time}]</span>
                                            <span className="font-bold">[{log.level}]</span>
                                            <span className="break-all">{log.msg}</span>
                                        </div>
                                    ))
                                )}
                                <div className="text-emerald-500/50 pt-4">--- END OF STREAM ---</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const StatusCard = ({ icon, label, value, sub, borderColor }: any) => <div className={`bg-card border ${borderColor} p-6 rounded-2xl shadow-sm`}><div className="flex items-center justify-between mb-2"><span className="text-xs text-muted-foreground font-bold uppercase">{label}</span>{icon}</div><div className="text-2xl font-black">{value}</div><div className="text-[10px] text-muted-foreground opacity-60 uppercase font-bold">{sub}</div></div>;

// DO fix: make children optional in ConfigField props type to avoid "Property children is missing" error when React inference is strict
const ConfigField = ({ label, sub, children }: { label: string, sub: string, children?: React.ReactNode }) => (
    <div className="space-y-2">
        <label className="block text-sm font-black text-foreground uppercase tracking-tight">{label}</label>
        <p className="text-[10px] text-muted-foreground leading-tight">{sub}</p>
        <div className="pt-2">
            {children}
        </div>
    </div>
);

export default SystemAdminView;