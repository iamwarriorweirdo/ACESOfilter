
import { SystemConfig, Language, Document } from '../types';
import { TRANSLATIONS } from '../constants';
import { Server, Activity, Cpu, Save, Settings, Users, Scale, Loader2, Globe, Layers, History, ShieldCheck, BarChart3, TrendingUp, BrainCircuit, CheckCircle, XCircle, DownloadCloud, Zap, Cloud, HardDrive, Terminal, ShieldAlert, FileJson, RefreshCw, Key, Database, ChevronRight, Workflow, ScanEye } from 'lucide-react';
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
    const [isSyncing, setIsSyncing] = useState(false);

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

    const handleDownloadBackup = async () => {
        setIsBackingUp(true);
        try {
            window.location.href = '/api/app?handler=backup';
        } finally {
            setTimeout(() => setIsBackingUp(false), 2000);
        }
    };

    const handleSyncDatabase = async () => {
        if (!confirm(t.syncAlert)) return;
        setIsSyncing(true);
        try {
            const res = await fetch('/api/app?handler=sync');
            const data = await res.json();
            if (data.success) {
                alert(data.message || t.syncing);
            } else {
                alert(t.syncFailed + data.error);
            }
        } catch (e: any) {
            alert(t.syncFailed + e.message);
        } finally {
            setIsSyncing(false);
        }
    };

    const totalSizeMB = (documents.reduce((acc, doc) => acc + (Number(doc.size) || 0), 0) / (1024 * 1024)).toFixed(2);
    
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
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
                    <StatusCard icon={<Activity className="text-green-500" />} label={t.sysStatus} value={t.sysActive} sub={t.sysFailover} borderColor="border-green-500/20" />
                    <StatusCard icon={<Zap className="text-orange-500" />} label={t.aiEngine} value={t.aiHybrid} sub={t.aiSub} borderColor="border-orange-500/20" />
                    <StatusCard icon={<Cloud className="text-blue-500" />} label={t.storage} value={t.storageConnected} sub={t.storageSub} borderColor="border-blue-500/20" />
                    <StatusCard icon={<Layers className="text-indigo-500" />} label={t.capacity} value={`${totalSizeMB} MB`} sub={t.capacitySub} borderColor="border-indigo-500/20" />
                    <StatusCard icon={<Cpu className="text-amber-500" />} label={t.mainModel} value={localConfig.chatModel === 'auto' ? "AUTO" : "MANUAL"} sub={t.procUnit} borderColor="border-amber-500/20" />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    <div className="lg:col-span-2 space-y-8">
                        <div className="bg-card border border-border rounded-[2rem] p-8 shadow-sm space-y-6">
                            <div className="flex items-center justify-between border-b border-border pb-4">
                                <div className="flex items-center gap-3">
                                    <BrainCircuit className="text-primary" />
                                    <h3 className="text-xl font-bold uppercase tracking-tight">{t.aiConfigTitle}</h3>
                                </div>
                                {hasChanges && (
                                    <button onClick={handleSave} disabled={isSaving} className="flex items-center gap-2 px-6 py-2 bg-primary text-white rounded-xl text-xs font-black shadow-lg shadow-primary/20 hover:scale-105 active:scale-95 transition-all">
                                        {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                                        {t.saveChanges}
                                    </button>
                                )}
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <ConfigField label={t.ocrStrategy} sub={t.ocrStrategyDesc}>
                                    <select 
                                        value={localConfig.ocrModel || 'auto'}
                                        onChange={e => handleLocalChange('ocrModel', e.target.value)}
                                        className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none text-foreground"
                                    >
                                        <option value="auto">{t.autoRecommended}</option>
                                        <optgroup label="Gemini 3 (Latest)">
                                            <option value="gemini-3-flash-preview">Gemini 3 Flash</option>
                                            <option value="gemini-3-pro-preview">Gemini 3 Pro</option>
                                        </optgroup>
                                        <optgroup label="Gemini 2.5">
                                            <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                                            <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                                        </optgroup>
                                        <optgroup label="Gemini 2">
                                            <option value="gemini-2.0-flash">Gemini 2 Flash</option>
                                            <option value="gemini-2.0-pro-exp">Gemini 2 Pro (Exp)</option>
                                        </optgroup>
                                    </select>
                                </ConfigField>

                                <ConfigField label={t.embeddingModel} sub={t.embeddingModelDesc}>
                                    <select 
                                        value={localConfig.embeddingModel || 'embedding-001'}
                                        onChange={e => handleLocalChange('embeddingModel', e.target.value)}
                                        className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none text-foreground"
                                    >
                                        <option value="embedding-001">Gemini Embedding 1 ({t.autoRecommended.split('(')[1].replace(')', '')})</option>
                                        <option value="text-embedding-3-small">OpenAI Embedding 3 Small</option>
                                    </select>
                                </ConfigField>

                                <ConfigField label={t.analysisEngine} sub={t.analysisEngineDesc}>
                                    <select 
                                        value={localConfig.analysisModel || 'auto'}
                                        onChange={e => handleLocalChange('analysisModel', e.target.value)}
                                        className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none text-foreground"
                                    >
                                        <option value="auto">{t.autoBest}</option>
                                        <option value="gemini-3-flash-preview">Gemini 3 Flash</option>
                                        <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                                        <option value="gpt-4o-mini">GPT-4o Mini</option>
                                        <option value="llama-3.3-70b-versatile">Groq Llama 3.3</option>
                                    </select>
                                </ConfigField>

                                <ConfigField label={t.chatModel} sub={t.chatModelDesc}>
                                    <select 
                                        value={localConfig.chatModel || 'auto'}
                                        onChange={e => handleLocalChange('chatModel', e.target.value)}
                                        className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none text-foreground"
                                    >
                                        <option value="auto">{t.autoDynamic}</option>
                                        <optgroup label="Gemini 3">
                                            <option value="gemini-3-pro-preview">Gemini 3 Pro</option>
                                            <option value="gemini-3-flash-preview">Gemini 3 Flash</option>
                                        </optgroup>
                                        <optgroup label="Gemini 2.5">
                                            <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                                            <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                                        </optgroup>
                                        <optgroup label="Groq AI">
                                            <option value="llama-3.3-70b-versatile">Llama 3.3 70B</option>
                                        </optgroup>
                                    </select>
                                </ConfigField>
                                
                                <ConfigField label={t.uploadLimit} sub={t.uploadLimitDesc}>
                                    <input 
                                        type="number"
                                        min="1"
                                        max="500"
                                        value={localConfig.maxFileSizeMB || 100}
                                        onChange={e => handleLocalChange('maxFileSizeMB', parseInt(e.target.value) || 100)}
                                        className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 outline-none text-foreground"
                                    />
                                </ConfigField>
                            </div>
                        </div>

                        <div className="bg-card border border-border rounded-[2rem] p-8 shadow-sm space-y-6">
                            <div className="flex items-center justify-between border-b border-border pb-4">
                                <div className="flex items-center gap-3">
                                    <Key className="text-orange-500" />
                                    <h3 className="text-xl font-bold uppercase tracking-tight">{t.apiSecurityTitle}</h3>
                                </div>
                            </div>
                            
                            <div className="space-y-4">
                                <p className="text-xs text-muted-foreground italic bg-muted/30 p-3 rounded-lg border border-border">
                                    {t.envVarNote}
                                </p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
                                    <ConfigField label={t.ocrApiKey} sub={t.ocrApiKeyDesc}>
                                        <div className="relative">
                                            <ScanEye className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
                                            <input 
                                                type="password"
                                                value={localConfig.ocrApiKey || ''}
                                                onChange={e => handleLocalChange('ocrApiKey', e.target.value)}
                                                className="w-full bg-muted/50 border border-border rounded-xl pl-10 pr-4 py-3 text-sm font-mono outline-none focus:ring-2 focus:ring-primary/20 text-foreground"
                                                placeholder="AIzaSy..."
                                            />
                                        </div>
                                    </ConfigField>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-8">
                        <div className="bg-card border border-border rounded-[2rem] p-8 shadow-sm space-y-6">
                            <h3 className="text-sm font-black uppercase tracking-widest text-muted-foreground border-b border-border pb-4 flex items-center gap-2">
                                <Database size={16} /> {t.dataMgmtTitle}
                            </h3>
                            <div className="space-y-3">
                                <button onClick={handleDownloadBackup} disabled={isBackingUp} className="w-full flex items-center justify-between p-4 rounded-2xl bg-muted/30 hover:bg-primary/10 border border-border hover:border-primary/20 transition-all group">
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 rounded-lg bg-background border border-border group-hover:bg-primary group-hover:text-white transition-all text-foreground">
                                            {isBackingUp ? <Loader2 size={16} className="animate-spin" /> : <FileJson size={16} />}
                                        </div>
                                        <div className="text-left">
                                            <div className="text-xs font-bold text-foreground">{t.backupSystem}</div>
                                            <div className="text-[10px] text-muted-foreground">{t.backupDesc}</div>
                                        </div>
                                    </div>
                                    <DownloadCloud size={16} className="text-muted-foreground" />
                                </button>

                                <button onClick={handleSyncDatabase} disabled={isSyncing} className="w-full flex items-center justify-between p-4 rounded-2xl bg-muted/30 hover:bg-emerald-500/10 border border-border hover:border-emerald-500/20 transition-all group">
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 rounded-lg bg-background border border-border group-hover:bg-emerald-500 group-hover:text-white transition-all text-foreground">
                                            {isSyncing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                                        </div>
                                        <div className="text-left">
                                            <div className="text-xs font-bold text-foreground">{t.syncVector}</div>
                                            <div className="text-[10px] text-muted-foreground">{t.syncVectorDesc}</div>
                                        </div>
                                    </div>
                                    <ChevronRight size={16} className="text-muted-foreground" />
                                </button>
                            </div>
                        </div>

                        <div className="bg-[#0d0d0d] border border-white/5 rounded-[2rem] overflow-hidden shadow-2xl flex flex-col h-[400px]">
                            <div className="px-6 py-4 border-b border-white/5 bg-white/5 flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <Terminal size={14} className="text-emerald-500" />
                                    <span className="text-[10px] font-black uppercase tracking-widest text-emerald-500">{t.logs}</span>
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

const StatusCard = ({ icon, label, value, sub, borderColor }: any) => (
    <div className={`bg-card border ${borderColor} p-6 rounded-2xl shadow-sm`}>
        <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground font-bold uppercase">{label}</span>
            {icon}
        </div>
        <div className="text-2xl font-black text-foreground">{value}</div>
        <div className="text-[10px] text-muted-foreground opacity-60 uppercase font-bold">{sub}</div>
    </div>
);

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
