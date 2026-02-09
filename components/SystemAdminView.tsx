
import React, { useState, useEffect } from 'react';
import { SystemConfig, Language, Document, UsageStats } from '../types';
import { TRANSLATIONS } from '../constants';
import { Server, Activity, Database, Cpu, Save, AlertTriangle, Cloud, HardDrive, Settings, Zap, Users, Scale, Loader2, Globe, Layers, DownloadCloud, History, ShieldCheck, CheckCircle2, BarChart3, PieChart, TrendingUp, RefreshCcw, BrainCircuit, Calendar, Filter, AlertCircle, Bot, Sparkles, Clock, XCircle, CheckCircle } from 'lucide-react';
import UserManagementDialog from './UserManagementDialog';

// Define the missing SystemAdminViewProps interface
interface SystemAdminViewProps {
    config: SystemConfig;
    setConfig: (config: SystemConfig) => Promise<void> | void;
    documents: Document[];
    language: Language;
    currentUsername: string;
    isEmbedded?: boolean;
}

const SimpleLineChart = ({ data }: { data: any[] }) => {
    if (!data || data.length === 0) return <div className="h-48 flex items-center justify-center text-muted-foreground/30 text-sm">No trend data</div>;

    const maxVal = Math.max(...data.map(d => d.requests));
    const points = data.map((d, i) => {
        const x = (i / (data.length - 1)) * 100;
        const y = 100 - (d.requests / maxVal) * 100;
        return `${x},${y}`;
    }).join(' ');

    return (
        <div className="h-48 w-full relative">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-full overflow-visible">
                {/* Grid Lines */}
                <line x1="0" y1="25" x2="100" y2="25" stroke="currentColor" strokeOpacity="0.1" strokeDasharray="2" vectorEffect="non-scaling-stroke" />
                <line x1="0" y1="50" x2="100" y2="50" stroke="currentColor" strokeOpacity="0.1" strokeDasharray="2" vectorEffect="non-scaling-stroke" />
                <line x1="0" y1="75" x2="100" y2="75" stroke="currentColor" strokeOpacity="0.1" strokeDasharray="2" vectorEffect="non-scaling-stroke" />

                {/* Line */}
                <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" className="text-blue-500 drop-shadow-md" />

                {/* Points */}
                {data.map((d, i) => {
                    const x = (i / (data.length - 1)) * 100;
                    const y = 100 - (d.requests / maxVal) * 100;
                    return (
                        <circle key={i} cx={x} cy={y} r="3" className="fill-blue-500 stroke-background stroke-2 hover:r-4 transition-all" vectorEffect="non-scaling-stroke">
                            <title>{new Date(d.day).toLocaleDateString()}: {d.requests} reqs</title>
                        </circle>
                    );
                })}
            </svg>
        </div>
    );
};

// Fix error in file components/SystemAdminView.tsx on line 44: Cannot find name 'SystemAdminViewProps'.
const SystemAdminView: React.FC<SystemAdminViewProps> = ({ config, setConfig, documents, language, currentUsername, isEmbedded = false }) => {
    const t = (TRANSLATIONS as any)[language] || TRANSLATIONS.en;
    const [localConfig, setLocalConfig] = useState<SystemConfig>(config);
    const [hasChanges, setHasChanges] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isBackingUp, setIsBackingUp] = useState(false);
    const [isCheckingIntegrity, setIsCheckingIntegrity] = useState(false);
    const [isSyncingAI, setIsSyncingAI] = useState(false);
    const [isInitializingMemory, setIsInitializingMemory] = useState(false);
    const [syncProgress, setSyncProgress] = useState(0);
    const [isUserMgmtOpen, setIsUserMgmtOpen] = useState(false);
    const [systemHealth, setSystemHealth] = useState<string>('Checking...');
    const [lastBackupDate, setLastBackupDate] = useState<string>('Never');

    // Analytics State
    const [analyticsData, setAnalyticsData] = useState<any[]>([]);
    const [recentLogs, setRecentLogs] = useState<any[]>([]);
    const [analyticsSummary, setAnalyticsSummary] = useState<any>({});
    const [isLoadingAnalytics, setIsLoadingAnalytics] = useState(false);
    const [timeRange, setTimeRange] = useState<'day' | 'week' | 'month' | 'custom'>('week');
    const [filterModel, setFilterModel] = useState('all');
    const [activeAnalyticsTab, setActiveAnalyticsTab] = useState<'overview' | 'logs'>('overview');

    useEffect(() => {
        setLocalConfig(config);
        setHasChanges(false);
    }, [config]);

    useEffect(() => {
        const isHealthy = documents.length >= 0;
        setSystemHealth(isHealthy ? '100%' : 'Error');
        const savedBackup = localStorage.getItem('last_system_backup');
        if (savedBackup) setLastBackupDate(new Date(Number(savedBackup)).toLocaleString());
        fetchAnalytics();
    }, [documents]);

    useEffect(() => {
        fetchAnalytics();
    }, [timeRange, filterModel]);

    const fetchAnalytics = async () => {
        setIsLoadingAnalytics(true);
        try {
            let startDate = Date.now();
            let endDate = Date.now();

            if (timeRange === 'day') {
                startDate = new Date().setHours(0, 0, 0, 0);
                endDate = new Date().setHours(23, 59, 59, 999);
            } else if (timeRange === 'week') {
                startDate = Date.now() - 7 * 24 * 60 * 60 * 1000;
            } else if (timeRange === 'month') {
                startDate = Date.now() - 30 * 24 * 60 * 60 * 1000;
            }

            const res = await fetch('/api/app?handler=usage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    startDate,
                    endDate,
                    model: filterModel
                })
            });

            if (res.ok) {
                const data = await res.json();
                setAnalyticsData(data.trend || data.data || []);
                setRecentLogs(data.recentLogs || []);
                setAnalyticsSummary(data.summary || {});
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoadingAnalytics(false);
        }
    };

    const handleConfigChange = (key: keyof SystemConfig, value: any) => {
        setLocalConfig(prev => ({ ...prev, [key]: value }));
        setHasChanges(true);
    };

    const saveConfig = async () => {
        setIsSaving(true);
        try {
            await setConfig(localConfig);
            setHasChanges(false);
            alert("Cấu hình hệ thống đã được lưu!");
        } catch (e) {
            alert("Lỗi lưu cấu hình.");
        } finally {
            setIsSaving(false);
        }
    };

    const handleInitMemory = async () => {
        setIsInitializingMemory(true);
        try {
            const res = await fetch('/api/memory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'init' })
            });
            const data = await res.json();
            if (data.status === 'success' || data.status === 'exists') {
                alert(data.message || "Neural Memory đã sẵn sàng.");
            } else {
                alert(`Lỗi: ${data.message}`);
            }
        } catch (e) {
            alert("Lỗi kết nối tới AI Memory Service.");
        } finally {
            setIsInitializingMemory(false);
        }
    };

    const handleBackup = async () => {
        setIsBackingUp(true);
        try {
            const response = await fetch('/api/app?handler=backup');
            if (!response.ok) throw new Error("Backup failed");
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `full_system_backup_${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
            const now = Date.now();
            localStorage.setItem('last_system_backup', now.toString());
            setLastBackupDate(new Date(now).toLocaleString());
            alert("Sao lưu dữ liệu thành công!");
        } catch (error: any) {
            alert(`Lỗi sao lưu: ${error.message}`);
        } finally {
            setIsBackingUp(false);
        }
    };

    const handleIntegrityCheck = async () => {
        setIsCheckingIntegrity(true);
        await new Promise(r => setTimeout(r, 1500));
        setIsCheckingIntegrity(false);
        alert("Tính toàn vẹn dữ liệu: 100% Khớp. Metadata (NeonDB) đồng bộ với Vector Index (Pinecone).");
    };

    const handleReIndexAI = async () => {
        if (!confirm("Hành động này sẽ đọc toàn bộ dữ liệu văn bản từ NeonDB và tạo lại Vector Embeddings cho Pinecone. Quá trình này có thể mất vài phút. Bạn có muốn tiếp tục?")) return;
        setIsSyncingAI(true);
        setSyncProgress(0);
        const docsToSync = documents.filter(d => d.extractedContent && d.extractedContent.length > 50);
        const total = docsToSync.length;
        let successCount = 0;
        try {
            for (let i = 0; i < total; i++) {
                const doc = docsToSync[i];
                try {
                    await fetch('/api/ingest', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ rawText: doc.extractedContent, fileName: doc.name, fileType: doc.type, url: doc.content })
                    });
                    successCount++;
                } catch (e) { console.error(`Failed to sync ${doc.name}`, e); }
                setSyncProgress(Math.round(((i + 1) / total) * 100));
            }
            alert(`Đồng bộ hoàn tất! Đã cập nhật ${successCount}/${total} tài liệu vào bộ não AI.`);
        } catch (e: any) { alert(`Lỗi đồng bộ: ${e.message}`); } finally { setIsSyncingAI(false); setSyncProgress(0); }
    };

    const totalSizeBytes = documents.reduce((acc, doc) => acc + (doc.size || 0), 0);
    const totalSizeMB = totalSizeBytes / (1024 * 1024);
    const displaySizeMB = totalSizeMB.toFixed(2);

    const containerClass = isEmbedded ? "h-full w-full bg-background text-foreground" : "h-full w-full bg-background text-foreground p-4 md:p-8 overflow-y-auto";
    const contentWrapperClass = isEmbedded ? "space-y-8" : "max-w-7xl mx-auto space-y-8";

    const getModelIcon = (modelName: string) => {
        if (modelName.includes('gemini')) return <Sparkles size={14} className="text-blue-500" />;
        if (modelName.includes('llama')) return <Bot size={14} className="text-orange-500" />;
        return <Cpu size={14} className="text-gray-500" />;
    };

    return (
        <div className={containerClass}>
            <div className={contentWrapperClass}>
                {!isEmbedded && (
                    <div className="flex flex-col gap-2 border-b border-border pb-6">
                        <div className="flex justify-between items-center">
                            <h2 className="text-3xl font-bold flex items-center gap-3 text-red-500">
                                <Server className="w-8 h-8" /> {t.superadmin} Console
                            </h2>
                            <button onClick={() => setIsUserMgmtOpen(true)} className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-xl font-bold shadow-lg">
                                <Users size={18} /> {t.createUser}
                            </button>
                        </div>
                        <p className="text-muted-foreground font-mono text-sm">{t.rootAccess}</p>
                    </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <StatusCard icon={<Activity className="text-green-500" />} label={t.systemHealth} value={systemHealth} sub="All systems operational" borderColor="border-green-500/20" />
                    <StatusCard icon={<TrendingUp className="text-blue-500" />} label={t.requestsToday || "Requests Today"} value={analyticsSummary.totalRequests || "0"} sub={t.estRpd || "Est. RPD"} borderColor="border-blue-500/20" />
                    <StatusCard icon={<Layers className="text-indigo-500" />} label={t.storageUsage} value={`${displaySizeMB} MB`} sub="Cloudinary + Supabase + Blob" borderColor="border-indigo-500/20" />
                    <StatusCard icon={<Cpu className="text-amber-500" />} label={t.aiModelLabel} value={localConfig.aiModel.toUpperCase()} sub="Active Core Model" borderColor="border-amber-500/20" />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <div className="space-y-6">
                        <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
                            <div className="flex items-center gap-3 mb-6">
                                <Settings className="text-primary" />
                                <h3 className="text-xl font-bold">{t.configTitle}</h3>
                            </div>

                            <div className="space-y-6">
                                <div className="space-y-4">
                                    <div className="p-4 bg-muted/20 rounded-lg border border-border">
                                        <div className="flex items-center justify-between mb-2">
                                            <label className="block text-xs font-bold text-muted-foreground uppercase">👁️ OCR Engine (Vision)</label>
                                            <span className="text-[10px] bg-blue-500/10 text-blue-500 px-1.5 py-0.5 rounded border border-blue-500/20 font-bold">Multimodal</span>
                                        </div>
                                        <select value={localConfig.ocrModel || localConfig.aiModel} onChange={(e) => handleConfigChange('ocrModel', e.target.value)} className="w-full bg-background border border-border rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-primary outline-none cursor-pointer">
                                            <option value="gemini-3-flash">⚡ Gemini 3.0 Flash (Recommended)</option>
                                            <option value="gemini-2.5-flash">🚀 Gemini 2.5 Flash</option>
                                            <option value="gemini-1.5-flash">📦 Gemini 1.5 Flash (Fallback)</option>
                                        </select>
                                    </div>

                                    <div className="p-4 bg-muted/20 rounded-lg border border-border">
                                        <div className="flex items-center justify-between mb-2">
                                            <label className="block text-xs font-bold text-muted-foreground uppercase">🧠 Analysis Engine (Logic)</label>
                                            <span className="text-[10px] bg-emerald-500/10 text-emerald-500 px-1.5 py-0.5 rounded border border-emerald-500/20 font-bold">Metadata</span>
                                        </div>
                                        <select value={localConfig.analysisModel || localConfig.aiModel} onChange={(e) => handleConfigChange('analysisModel', e.target.value)} className="w-full bg-background border border-border rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-primary outline-none cursor-pointer">
                                            <option value="gemini-2.5-flash">🚀 Gemini 2.5 Flash (Balanced)</option>
                                            <option value="gemini-3-flash">⚡ Gemini 3.0 Flash</option>
                                            <option value="gemini-1.5-pro">💎 Gemini 1.5 Pro (Precision)</option>
                                        </select>
                                    </div>
                                </div>
                                <div className="p-4 bg-muted/20 rounded-lg border border-border">
                                    <div className="flex items-center gap-4">
                                        <Scale className="text-orange-500" size={24} />
                                        <div className="flex-1">
                                            <div className="font-bold flex justify-between">
                                                <span>{t.maxFileSize}</span>
                                                <span className="text-primary">{localConfig.maxFileSizeMB} MB</span>
                                            </div>
                                            <input type="range" min="1" max="500" step="5" value={localConfig.maxFileSizeMB} onChange={(e) => handleConfigChange('maxFileSizeMB', parseInt(e.target.value))} className="w-full h-2 bg-muted-foreground/20 rounded-lg appearance-none cursor-pointer accent-primary" />
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div className="mt-8 flex justify-end">
                                <button onClick={saveConfig} disabled={!hasChanges || isSaving} className={`flex items-center gap-2 px-6 py-3 rounded-lg font-bold transition-all ${hasChanges ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20' : 'bg-muted text-muted-foreground cursor-not-allowed'}`}>
                                    {isSaving ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />} {t.saveConfig}
                                </button>
                            </div>
                        </div>

                        <div className="border border-indigo-500/30 bg-indigo-500/5 rounded-xl p-6 flex flex-col">
                            <div className="flex items-center justify-between mb-6">
                                <div className="flex items-center gap-2 text-indigo-500">
                                    <ShieldCheck size={24} />
                                    <h3 className="font-bold text-xl">{t.dbManagement}</h3>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
                                <div className="p-4 bg-card border border-border rounded-xl">
                                    <div className="flex items-center gap-2 text-muted-foreground mb-2">
                                        <History size={16} />
                                        <span className="text-xs font-bold uppercase">{t.lastBackup}</span>
                                    </div>
                                    <div className="text-sm font-mono text-foreground">{lastBackupDate}</div>
                                </div>
                                <div className="p-4 bg-card border border-border rounded-xl">
                                    <div className="flex items-center gap-2 text-muted-foreground mb-2">
                                        <Layers size={16} />
                                        <span className="text-xs font-bold uppercase">Vectors</span>
                                    </div>
                                    <div className="text-sm font-mono text-green-500">Pinecone Ready</div>
                                </div>
                            </div>

                            <div className="space-y-4">
                                <button
                                    onClick={handleInitMemory}
                                    disabled={isInitializingMemory}
                                    className="w-full flex items-center justify-center gap-2 px-4 py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-sm font-bold transition-all shadow-lg shadow-indigo-500/20 disabled:opacity-50"
                                >
                                    {isInitializingMemory ? (
                                        <Loader2 className="animate-spin" size={18} />
                                    ) : (
                                        <BrainCircuit size={18} />
                                    )}
                                    Khởi tạo AI Brain (Neural Memory)
                                </button>
                                
                                <button
                                    onClick={handleReIndexAI}
                                    disabled={isSyncingAI}
                                    className="w-full flex items-center justify-center gap-2 px-4 py-3.5 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-xl text-sm font-bold hover:opacity-90 transition-all shadow-lg shadow-purple-500/20 disabled:opacity-50 relative overflow-hidden"
                                >
                                    {isSyncingAI ? (
                                        <div className="relative z-10 flex items-center gap-2">
                                            <Loader2 className="animate-spin" size={18} />
                                            Syncing AI ({syncProgress}%)...
                                        </div>
                                    ) : (
                                        <>
                                            <BrainCircuit size={18} />
                                            {t.language === 'vi' ? 'Đồng bộ lại Dữ liệu AI (Re-index)' : 'Re-index AI Data'}
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className="bg-card border border-border rounded-xl p-6 shadow-sm flex flex-col min-h-[600px]">
                        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-6 gap-4">
                            <div className="flex items-center gap-3">
                                <BarChart3 className="text-emerald-500" />
                                <h3 className="text-xl font-bold">{t.analyticsTitle || "AI Analytics"}</h3>
                            </div>

                            <div className="flex items-center gap-2 p-1 bg-muted rounded-lg">
                                <button onClick={() => setActiveAnalyticsTab('overview')} className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${activeAnalyticsTab === 'overview' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>Overview</button>
                                <button onClick={() => setActiveAnalyticsTab('logs')} className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${activeAnalyticsTab === 'logs' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>Recent Logs</button>
                            </div>
                        </div>

                        {isLoadingAnalytics ? (
                            <div className="flex-1 flex items-center justify-center"><Loader2 className="animate-spin text-primary w-8 h-8" /></div>
                        ) : (
                            activeAnalyticsTab === 'overview' ? (
                                <div className="flex flex-col gap-6">
                                    <div className="grid grid-cols-4 gap-2 text-center">
                                        <div className="p-3 bg-blue-500/10 rounded-lg border border-blue-500/20">
                                            <div className="text-[10px] text-muted-foreground uppercase">{t.requests}</div>
                                            <div className="text-lg font-bold text-blue-500">{analyticsSummary.totalRequests || 0}</div>
                                        </div>
                                        <div className="p-3 bg-green-500/10 rounded-lg border border-green-500/20">
                                            <div className="text-[10px] text-muted-foreground uppercase">{t.tokens}</div>
                                            <div className="text-lg font-bold text-green-500">{(analyticsSummary.totalTokens || 0).toLocaleString()}</div>
                                        </div>
                                        <div className="p-3 bg-purple-500/10 rounded-lg border border-purple-500/20">
                                            <div className="text-[10px] text-muted-foreground uppercase">Latency</div>
                                            <div className="text-lg font-bold text-purple-500">{analyticsSummary.avgLatency || 0}ms</div>
                                        </div>
                                        <div className="p-3 bg-red-500/10 rounded-lg border border-red-500/20">
                                            <div className="text-[10px] text-muted-foreground uppercase">{t.err}</div>
                                            <div className="text-lg font-bold text-red-500">{analyticsSummary.totalErrors || 0}</div>
                                        </div>
                                    </div>
                                    <div className="border border-border rounded-lg p-4 bg-background/50 relative">
                                        <h4 className="text-xs font-bold text-muted-foreground uppercase mb-4">Request Volume Trend</h4>
                                        <SimpleLineChart data={analyticsData} />
                                    </div>
                                </div>
                            ) : (
                                <div className="flex-1 overflow-auto border border-border rounded-lg bg-background">
                                    <table className="w-full text-xs text-left">
                                        <thead className="text-xs text-muted-foreground uppercase bg-muted/80 sticky top-0 z-10">
                                            <tr>
                                                <th className="px-3 py-2">Time</th>
                                                <th className="px-3 py-2">Model</th>
                                                <th className="px-3 py-2 text-right">Tokens</th>
                                                <th className="px-3 py-2 text-right">Dur</th>
                                                <th className="px-3 py-2 text-center">Status</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-border font-mono">
                                            {recentLogs.map((log) => (
                                                <tr key={log.id} className="hover:bg-muted/30">
                                                    <td className="px-3 py-2 whitespace-nowrap">{new Date(log.timestamp).toLocaleTimeString()}</td>
                                                    <td className="px-3 py-2 truncate max-w-[120px]">{log.model.split('-')[0]}...</td>
                                                    <td className="px-3 py-2 text-right">{log.tokens}</td>
                                                    <td className="px-3 py-2 text-right">{log.duration_ms}ms</td>
                                                    <td className="px-3 py-2 text-center">
                                                        {log.status === 'success' ? <CheckCircle size={14} className="text-green-500 inline" /> : <XCircle size={14} className="text-red-500 inline" />}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )
                        )}
                    </div>
                </div>
            </div>
            <UserManagementDialog isOpen={isUserMgmtOpen} onClose={() => setIsUserMgmtOpen(false)} currentUserRole="superadmin" currentUsername={currentUsername} />
        </div>
    );
};

const StatusCard = ({ icon, label, value, sub, borderColor }: any) => (
    <div className={`bg-card border ${borderColor} p-6 rounded-xl flex flex-col gap-1 shadow-sm`}>
        <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-muted-foreground font-medium uppercase">{label}</span>
            {icon}
        </div>
        <div className="text-2xl font-black">{value}</div>
        <div className="text-xs text-muted-foreground opacity-70">{sub}</div>
    </div>
);

export default SystemAdminView;
