
import { SystemConfig, Language, Document } from '../types';
import { TRANSLATIONS } from '../constants';
import { Server, Activity, Cpu, Save, Settings, Users, Scale, Loader2, Globe, Layers, History, ShieldCheck, BarChart3, TrendingUp, BrainCircuit, CheckCircle, XCircle, DownloadCloud, Zap, Cloud } from 'lucide-react';
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
                <div className="grid grid-cols-1 md:grid-cols-4 lg:grid-cols-5 gap-4">
                    <StatusCard icon={<Activity className="text-green-500" />} label="Hệ thống" value="Active" sub="Multi-Cloud Failover" borderColor="border-green-500/20" />
                    <StatusCard icon={<Zap className="text-yellow-500" />} label="Dự phòng Groq" value={process.env.GROQ_API_KEY ? "READY" : "OFF"} sub="Llama-3-70B" borderColor="border-yellow-500/20" />
                    <StatusCard icon={<Cloud className="text-blue-500" />} label="Hugging Face" value={process.env.HUGGING_FACE_API_KEY ? "ONLINE" : "OFF"} sub="Mistral/Phi-3" borderColor="border-blue-500/20" />
                    <StatusCard icon={<Layers className="text-indigo-500" />} label="Dung lượng" value={`${totalSizeMB} MB`} sub="Hybrid DB" borderColor="border-indigo-500/20" />
                    <StatusCard icon={<Cpu className="text-amber-500" />} label="Model chính" value="GEMINI 3.0" sub="Standard OCR" borderColor="border-amber-500/20" />
                </div>

                <div className="bg-card border border-border rounded-2xl p-6 shadow-sm">
                    <div className="flex items-center gap-3 mb-6">
                        <ShieldCheck className="text-primary" />
                        <h3 className="text-xl font-bold">Cấu hình Tự động Chuyển đổi (Failover Level 3)</h3>
                    </div>
                    <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl mb-6">
                        <p className="text-xs text-blue-400 font-medium">
                            Chế độ <b>Ultra-Resilience</b> đã được kích hoạt. Chuỗi xử lý: 
                            <span className="mx-2 font-bold text-white">Google Gemini</span> ➔ 
                            <span className="mx-2 font-bold text-white">Groq Llama-3</span> ➔ 
                            <span className="mx-2 font-bold text-white">Hugging Face Mistral</span>.
                        </p>
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                         <div className="p-4 border border-border rounded-xl">
                            <span className="text-[10px] font-black uppercase text-muted-foreground">OCR Strategy</span>
                            <p className="text-sm mt-1 font-bold">Gemini 3.0 Vision</p>
                            <p className="text-xs text-muted-foreground">High Accuracy / Intelligent Extraction</p>
                         </div>
                         <div className="p-4 border border-border rounded-xl">
                            <span className="text-[10px] font-black uppercase text-muted-foreground">Inference Failover</span>
                            <p className="text-sm mt-1 font-bold">Groq (Llama-3.1-70B)</p>
                            <p className="text-xs text-muted-foreground">Ultra-Fast 2nd Layer Fallback</p>
                         </div>
                         <div className="p-4 border border-border rounded-xl">
                            <span className="text-[10px] font-black uppercase text-muted-foreground">Hugging Face Failover</span>
                            <p className="text-sm mt-1 font-bold">Mistral-7B-Instruct</p>
                            <p className="text-xs text-muted-foreground">Open-Source 3rd Layer Safety</p>
                         </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const StatusCard = ({ icon, label, value, sub, borderColor }: any) => <div className={`bg-card border ${borderColor} p-6 rounded-2xl shadow-sm`}><div className="flex items-center justify-between mb-2"><span className="text-xs text-muted-foreground font-bold uppercase">{label}</span>{icon}</div><div className="text-2xl font-black">{value}</div><div className="text-[10px] text-muted-foreground opacity-60 uppercase font-bold">{sub}</div></div>;

export default SystemAdminView;
