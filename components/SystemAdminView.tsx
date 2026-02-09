
import { SystemConfig, Language, Document } from '../types';
import { TRANSLATIONS } from '../constants';
import { Server, Activity, Cpu, Save, Settings, Users, Scale, Loader2, Globe, Layers, History, ShieldCheck, BarChart3, TrendingUp, BrainCircuit, CheckCircle, XCircle, DownloadCloud, Zap } from 'lucide-react';
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

    const totalSizeMB = (documents.reduce((acc, doc) => acc + (Number(doc.size) || 0), 0) / (1024 * 1024)).toFixed(2);

    return (
        <div className={isEmbedded ? "h-full w-full bg-background p-6" : "p-8 overflow-y-auto"}>
            <div className="max-w-7xl mx-auto space-y-8">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <StatusCard icon={<Activity className="text-green-500" />} label="Hệ thống" value="Active" sub="Multi-Cloud Failover" borderColor="border-green-500/20" />
                    <StatusCard icon={<Zap className="text-yellow-500" />} label="Dự phòng Groq" value={process.env.GROQ_API_KEY ? "READY" : "OFF"} sub="Llama-3-70B" borderColor="border-yellow-500/20" />
                    <StatusCard icon={<Layers className="text-indigo-500" />} label="Dung lượng" value={`${totalSizeMB} MB`} sub="Hybrid DB" borderColor="border-indigo-500/20" />
                    <StatusCard icon={<Cpu className="text-amber-500" />} label="Model chính" value="GEMINI 3.0" sub="Standard OCR" borderColor="border-amber-500/20" />
                </div>

                <div className="bg-card border border-border rounded-2xl p-6 shadow-sm">
                    <div className="flex items-center gap-3 mb-6">
                        <ShieldCheck className="text-primary" />
                        <h3 className="text-xl font-bold">Cấu hình Tự động Chuyển đổi (Failover)</h3>
                    </div>
                    <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl mb-6">
                        <p className="text-xs text-blue-400 font-medium">
                            Chế độ <b>Smart Failover</b> đã được kích hoạt. Nếu Gemini (Google) trả về lỗi 429 (Hết lượt), hệ thống sẽ tự động sử dụng Groq (Llama-3) để xử lý yêu cầu Chat và Metadata.
                        </p>
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                         <div className="space-y-4">
                            <div className="p-4 border border-border rounded-xl">
                                <span className="text-[10px] font-black uppercase text-muted-foreground">OCR Strategy</span>
                                <p className="text-sm mt-1 font-bold">Primary: Gemini Vision 3.0</p>
                                <p className="text-xs text-muted-foreground">Secondary: Raw Parser + Llama-3 Refiner</p>
                            </div>
                         </div>
                         <div className="space-y-4">
                            <div className="p-4 border border-border rounded-xl">
                                <span className="text-[10px] font-black uppercase text-muted-foreground">Chat Strategy</span>
                                <p className="text-sm mt-1 font-bold">Primary: Gemini 3.0 Flash</p>
                                <p className="text-xs text-muted-foreground">Secondary: Groq Llama-3-70B (Fastest)</p>
                            </div>
                         </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const StatusCard = ({ icon, label, value, sub, borderColor }: any) => <div className={`bg-card border ${borderColor} p-6 rounded-2xl shadow-sm`}><div className="flex items-center justify-between mb-2"><span className="text-xs text-muted-foreground font-bold uppercase">{label}</span>{icon}</div><div className="text-2xl font-black">{value}</div><div className="text-[10px] text-muted-foreground opacity-60 uppercase font-bold">{sub}</div></div>;

export default SystemAdminView;
