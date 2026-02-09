
import { SystemConfig, Language, Document } from '../types';
import { TRANSLATIONS } from '../constants';
import { Server, Activity, Cpu, Save, Settings, Users, Scale, Loader2, Globe, Layers, History, ShieldCheck, BarChart3, TrendingUp, BrainCircuit, CheckCircle, XCircle, DownloadCloud, Zap, Cloud, HardDrive, Terminal, ShieldAlert, FileJson, RefreshCw, Key, Database, ChevronRight } from 'lucide-react';
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
                    <StatusCard icon={<Zap className="text-yellow-500" />} label="Dự phòng Groq" value={process.env.GROQ_API_KEY ? "READY" : "OFF"} sub="Llama-3-70B" borderColor="border-yellow-500/20" />
                    <StatusCard icon={<Cloud className="text-blue-500" />} label="Hugging Face" value={process.env.HUGGING_FACE_API_KEY ? "ONLINE" : "OFF"} sub="Phi-3 / Florence-2" borderColor="border-blue-500/20" />
                    <StatusCard icon={<Layers className="text-indigo-500" />} label="Dung lượng" value={`${totalSizeMB} MB`} sub="Hybrid DB" borderColor="border-indigo-500/20" />
                    <StatusCard icon={<Cpu className="text-amber-500" />} label="Model chính" value="GEMINI 3.0" sub="Standard OCR" borderColor="border-amber-500/20" />
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
                                <ConfigField label="OCR Strategy (Vision)" sub="Dùng để trích xuất chữ từ ảnh/PDF scan">
                                    <select 
                                        value={localConfig.ocrModel || 'gemini-3-flash-preview'}
                                        onChange={e => handleLocalChange('ocrModel', e.target.value)}
                                        className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none"
                                    >
                                        <option value="gemini-3-flash-preview">Gemini 3.0 Flash (Nhanh/Chính xác)</option>
                                        <option value="gemini-3-pro-preview">Gemini 3.0 Pro (Phức tạp/Dung lượng lớn)</option>
                                        <option value="gemini-2.5-flash-lite-latest">Gemini 2.5 Flash Lite (Tiết kiệm)</option>
                                        <option value="microsoft/Florence-2-base">HF: Microsoft Florence-2 (Standard OCR)</option>
                                        <option value="microsoft/Phi-3-vision-128k-instruct">HF: Microsoft Phi-3 Vision (Advanced VLM)</option>
                                    </select>
                                </ConfigField>

                                <ConfigField label="Analysis Engine" sub="Dùng để phân loại và tóm tắt JSON">
                                    <select 
                                        value={localConfig.analysisModel || 'gemini-3-flash-preview'}
                                        onChange={e => handleLocalChange('analysisModel', e.target.value)}
                                        className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none"
                                    >
                                        <option value="gemini-3-flash-preview">Gemini 3.0 Flash</option>
                                        <option value="gemini-3-pro-preview">Gemini 3.0 Pro (Tốt nhất cho JSON)</option>
                                    </select>
                                </ConfigField>

                                <ConfigField label="Chat RAG Interface" sub="Model tương tác trực tiếp với người dùng">
                                    <select 
                                        value={localConfig.chatModel || 'gemini-2.5-flash-lite'}
                                        onChange={e => handleLocalChange('chatModel', e.target.value)}
                                        className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none"
                                    >
                                        <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite (Siêu nhanh)</option>
                                        <option value="gemini-3-flash-preview">Gemini 3.0 Flash</option>
                                        <option value="gemini-3-pro-preview">Gemini 3.0 Pro (Thông minh nhất)</option>
                                    </select>
                                </ConfigField>

                                <ConfigField label="Max Ingest Size (MB)" sub="Giới hạn dung lượng tệp cho phép tải lên">
                                    <div className="flex items-center gap-3">
                                        <input 
                                            type="number" 
                                            value={localConfig.maxFileSizeMB}
                                            onChange={e => handleLocalChange('maxFileSizeMB', Number(e.target.value))}
                                            className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm font-bold outline-none"
                                        />
                                        <span className="text-xs font-black text-muted-foreground">MB</span>
                                    </div>
                                </ConfigField>
                            </div>
                        </div>

                        {/* Adobe Integration */}
                        <div className="bg-card border border-border rounded-[2rem] p-8 shadow-sm space-y-6">
                            <div className="flex items-center justify-between border-b border-border pb-4">
                                <div className="flex items-center gap-3">
                                    <Key className="text-orange-500" />
                                    <h3 className="text-xl font-bold uppercase tracking-tight">Adobe PDF Services</h3>
                                </div>
                                <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-[10px] font-black uppercase ${localConfig.enableAdobeCompression ? 'bg-green-500/10 text-green-500' : 'bg-muted text-muted-foreground'}`}>
                                    {localConfig.enableAdobeCompression ? 'Connected' : 'Disconnected'}
                                </div>
                            </div>
                            
                            <div className="space-y-4">
                                <div className="flex items-center gap-4 p-4 bg-orange-500/5 border border-orange-500/10 rounded-2xl">
                                    <ShieldAlert className="text-orange-500 shrink-0" size={20} />
                                    <p className="text-xs text-orange-400/80 leading-relaxed font-medium">
                                        Sử dụng Adobe PDF Services để nén và tối ưu hóa tài liệu PDF &gt;50MB trước khi xử lý AI. Yêu cầu tài khoản Adobe Developer.
                                    </p>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4">
                                    <ConfigField label="Adobe Client ID" sub="Lấy từ Adobe Developer Console">
                                        <input 
                                            type="password"
                                            value={localConfig.adobeClientId || ''}
                                            onChange={e => handleLocalChange('adobeClientId', e.target.value)}
                                            className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm font-mono outline-none"
                                            placeholder="••••••••"
                                        />
                                    </ConfigField>
                                    <ConfigField label="Adobe Client Secret" sub="Khóa bí mật truy cập API">
                                        <input 
                                            type="password"
                                            value={localConfig.adobeClientSecret || ''}
                                            onChange={e => handleLocalChange('adobeClientSecret', e.target.value)}
                                            className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm font-mono outline-none"
                                            placeholder="••••••••"
                                        />
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

const ConfigField = ({ label, sub, children }: { label: string, sub: string, children: React.ReactNode }) => (
    <div className="space-y-2">
        <label className="block text-sm font-black text-foreground uppercase tracking-tight">{label}</label>
        <p className="text-[10px] text-muted-foreground leading-tight">{sub}</p>
        <div className="pt-2">
            {children}
        </div>
    </div>
);

export default SystemAdminView;
