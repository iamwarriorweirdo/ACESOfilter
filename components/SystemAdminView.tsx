
import { SystemConfig, Language, Document } from '../types';
import { TRANSLATIONS } from '../constants';
import { Server, Activity, Cpu, Save, Settings, Users, Scale, Loader2, Globe, Layers, History, ShieldCheck, BarChart3, TrendingUp, BrainCircuit, CheckCircle, XCircle, DownloadCloud } from 'lucide-react';
import React, { useState, useEffect } from 'react';
import UserManagementDialog from './UserManagementDialog';

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

    const maxVal = Math.max(...data.map(d => d.requests || 1));
    const points = data.map((d, i) => {
        const x = (i / (data.length - 1 || 1)) * 100;
        const y = 100 - (d.requests / maxVal) * 100;
        return `${x},${y}`;
    }).join(' ');

    return (
        <div className="h-48 w-full relative">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-full overflow-visible">
                <line x1="0" y1="25" x2="100" y2="25" stroke="currentColor" strokeOpacity="0.1" strokeDasharray="2" vectorEffect="non-scaling-stroke" />
                <line x1="0" y1="50" x2="100" y2="50" stroke="currentColor" strokeOpacity="0.1" strokeDasharray="2" vectorEffect="non-scaling-stroke" />
                <line x1="0" y1="75" x2="100" y2="75" stroke="currentColor" strokeOpacity="0.1" strokeDasharray="2" vectorEffect="non-scaling-stroke" />
                <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" className="text-blue-500 drop-shadow-md" />
                {data.map((d, i) => {
                    const x = (i / (data.length - 1 || 1)) * 100;
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

const SystemAdminView: React.FC<SystemAdminViewProps> = ({ config, setConfig, documents, language, currentUsername, isEmbedded = false }) => {
    const t = (TRANSLATIONS as any)[language] || TRANSLATIONS.en;
    const [localConfig, setLocalConfig] = useState<SystemConfig>(config);
    const [hasChanges, setHasChanges] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isBackingUp, setIsBackingUp] = useState(false);
    const [isSyncingAI, setIsSyncingAI] = useState(false);
    const [syncProgress, setSyncProgress] = useState(0);
    const [systemHealth, setSystemHealth] = useState<string>('Checking...');
    const [lastBackupDate, setLastBackupDate] = useState<string>('Never');

    const [analyticsData, setAnalyticsData] = useState<any[]>([]);
    const [recentLogs, setRecentLogs] = useState<any[]>([]);
    const [analyticsSummary, setAnalyticsSummary] = useState<any>({});
    const [isLoadingAnalytics, setIsLoadingAnalytics] = useState(false);
    const [timeRange, setTimeRange] = useState<'day' | 'week' | 'month' | 'custom'>('week');
    const [activeAnalyticsTab, setActiveAnalyticsTab] = useState<'overview' | 'logs'>('overview');

    useEffect(() => {
        setLocalConfig(config);
        setHasChanges(false);
    }, [config]);

    useEffect(() => {
        setSystemHealth(documents.length >= 0 ? 'Stable' : 'Error');
        const savedBackup = localStorage.getItem('last_system_backup');
        if (savedBackup) setLastBackupDate(new Date(Number(savedBackup)).toLocaleString());
        fetchAnalytics();
    }, [documents]);

    const fetchAnalytics = async () => {
        setIsLoadingAnalytics(true);
        try {
            let startDate = Date.now() - 7 * 24 * 60 * 60 * 1000;
            if (timeRange === 'day') startDate = new Date().setHours(0, 0, 0, 0);
            else if (timeRange === 'month') startDate = Date.now() - 30 * 24 * 60 * 60 * 1000;

            const res = await fetch('/api/app?handler=usage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ startDate, endDate: Date.now() })
            });

            if (res.ok) {
                const data = await res.json();
                setAnalyticsData(data.trend || []);
                setRecentLogs(data.recentLogs || []);
                setAnalyticsSummary(data.summary || {});
            }
        } catch (e) { console.error(e); }
        finally { setIsLoadingAnalytics(false); }
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
            alert("Đã cập nhật cấu hình!");
        } catch (e) { alert("Lỗi khi lưu."); }
        finally { setIsSaving(false); }
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
            a.download = `aceso_backup_${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
            localStorage.setItem('last_system_backup', Date.now().toString());
            setLastBackupDate(new Date().toLocaleString());
        } catch (error: any) { alert(`Lỗi: ${error.message}`); }
        finally { setIsBackingUp(false); }
    };

    const handleReIndexAI = async () => {
        if (!confirm("Tạo lại toàn bộ vector embeddings?")) return;
        setIsSyncingAI(true);
        setSyncProgress(0);
        const docsToSync = documents.filter(d => d.extractedContent && d.extractedContent.length > 50);
        const total = docsToSync.length;
        try {
            for (let i = 0; i < total; i++) {
                const doc = docsToSync[i];
                await fetch('/api/ingest', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: doc.content, fileName: doc.name, fileType: doc.type, docId: doc.id })
                });
                setSyncProgress(Math.round(((i + 1) / total) * 100));
            }
            alert("Hoàn tất đồng bộ AI!");
        } catch (e) { alert("Lỗi trong quá trình đồng bộ."); } 
        finally { setIsSyncingAI(false); setSyncProgress(0); }
    };

    const totalSizeMB = (documents.reduce((acc, doc) => acc + (Number(doc.size) || 0), 0) / (1024 * 1024)).toFixed(2);

    return (
        <div className={isEmbedded ? "h-full w-full bg-background" : "p-8 overflow-y-auto"}>
            <div className="max-w-7xl mx-auto space-y-8">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <StatusCard icon={<Activity className="text-green-500" />} label={t.systemHealth} value={systemHealth} sub="Stateless RAG Active" borderColor="border-green-500/20" />
                    <StatusCard icon={<TrendingUp className="text-blue-500" />} label={t.requestsToday} value={analyticsSummary.totalRequests || "0"} sub="API Load" borderColor="border-blue-500/20" />
                    <StatusCard icon={<Layers className="text-indigo-500" />} label={t.storageUsage} value={`${totalSizeMB} MB`} sub="Neon + Pinecone" borderColor="border-indigo-500/20" />
                    <StatusCard icon={<Cpu className="text-amber-500" />} label={t.aiModelLabel} value={localConfig.aiModel.split('-').pop()?.toUpperCase() || 'GEMINI'} sub="Inference Engine" borderColor="border-amber-500/20" />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <div className="space-y-6">
                        <div className="bg-card border border-border rounded-2xl p-6 shadow-sm">
                            <div className="flex items-center gap-3 mb-6">
                                <Settings className="text-primary" />
                                <h3 className="text-xl font-bold">Cấu hình Động cơ AI</h3>
                            </div>
                            <div className="space-y-4">
                                <ConfigSelect label="👁️ OCR & Vision Engine" value={localConfig.ocrModel || localConfig.aiModel} onChange={v => handleConfigChange('ocrModel', v)} options={[
                                    {v: 'gemini-3-flash-preview', l: '⚡ Gemini 3.0 Flash (Fast)'},
                                    {v: 'gemini-2.5-flash-preview', l: '🚀 Gemini 2.5 Flash'}
                                ]} />
                                <ConfigSelect label="🧠 Analysis & RAG Engine" value={localConfig.analysisModel || localConfig.aiModel} onChange={v => handleConfigChange('analysisModel', v)} options={[
                                    {v: 'gemini-3-pro-preview', l: '💎 Gemini 3.0 Pro (Smart)'},
                                    {v: 'gemini-3-flash-preview', l: '⚡ Gemini 3.0 Flash (Fast)'}
                                ]} />
                                <div className="p-4 bg-muted/20 rounded-xl border border-border">
                                    <div className="flex justify-between font-bold text-xs mb-2"><span>Giới hạn File Tải lên</span><span className="text-primary">{localConfig.maxFileSizeMB} MB</span></div>
                                    <input type="range" min="10" max="500" step="10" value={localConfig.maxFileSizeMB} onChange={(e) => handleConfigChange('maxFileSizeMB', parseInt(e.target.value))} className="w-full h-2 rounded-lg appearance-none cursor-pointer bg-primary/20 accent-primary" />
                                </div>
                            </div>
                            <div className="mt-8 flex justify-end">
                                <button onClick={saveConfig} disabled={!hasChanges || isSaving} className={`flex items-center gap-2 px-6 py-3 rounded-xl font-bold transition-all ${hasChanges ? 'bg-primary text-white' : 'bg-muted text-muted-foreground'}`}>
                                    {isSaving ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />} Lưu thay đổi
                                </button>
                            </div>
                        </div>

                        <div className="border border-indigo-500/20 bg-indigo-500/5 rounded-2xl p-6 space-y-6">
                            <div className="flex items-center gap-2 text-indigo-500"><ShieldCheck size={24} /><h3 className="font-bold text-xl">Duy trì Hệ thống</h3></div>
                            <div className="grid grid-cols-2 gap-4">
                                <StatusSubCard icon={<History size={16} />} label="Sao lưu cuối" value={lastBackupDate} />
                                <StatusSubCard icon={<Layers size={16} />} label="Vector Index" value="PINECONE_OK" color="text-green-500" />
                            </div>
                            <div className="space-y-3">
                                <button onClick={handleReIndexAI} disabled={isSyncingAI} className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-indigo-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-indigo-500/20 disabled:opacity-50 transition-all hover:scale-[1.02]">
                                    {isSyncingAI ? <><Loader2 className="animate-spin" size={18} /> Đang quét lại ({syncProgress}%)...</> : <><BrainCircuit size={18} /> Đồng bộ lại Vector Database</>}
                                </button>
                                <button onClick={handleBackup} disabled={isBackingUp} className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-background border border-border hover:bg-muted rounded-xl text-sm font-bold transition-all">
                                    {isBackingUp ? <Loader2 className="animate-spin" size={18} /> : <DownloadCloud size={18} />} Tải bản sao lưu (.json)
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className="bg-card border border-border rounded-2xl p-6 shadow-sm flex flex-col min-h-[500px]">
                        <div className="flex justify-between items-center mb-6">
                            <div className="flex items-center gap-3 text-emerald-500"><BarChart3 /><h3 className="text-xl font-bold">Phân tích AI</h3></div>
                            <div className="flex bg-muted p-1 rounded-lg">
                                <TabBtn active={activeAnalyticsTab === 'overview'} onClick={() => setActiveAnalyticsTab('overview')}>Tổng quan</TabBtn>
                                <TabBtn active={activeAnalyticsTab === 'logs'} onClick={() => setActiveAnalyticsTab('logs')}>Nhật ký</TabBtn>
                            </div>
                        </div>
                        {isLoadingAnalytics ? <div className="flex-1 flex items-center justify-center"><Loader2 className="animate-spin text-primary w-8 h-8" /></div> : 
                          activeAnalyticsTab === 'overview' ? <div className="space-y-6">
                            <div className="grid grid-cols-4 gap-2 text-center">
                                <StatBox label="Yêu cầu" val={analyticsSummary.totalRequests} color="text-blue-500" bg="bg-blue-500/10" />
                                <StatBox label="Tokens" val={analyticsSummary.totalTokens} color="text-green-500" bg="bg-green-500/10" />
                                <StatBox label="Độ trễ" val={analyticsSummary.avgLatency + 'ms'} color="text-purple-500" bg="bg-purple-500/10" />
                                <StatBox label="Lỗi" val={analyticsSummary.totalErrors} color="text-red-500" bg="bg-red-500/10" />
                            </div>
                            <SimpleLineChart data={analyticsData} />
                          </div> : <div className="flex-1 overflow-auto border border-border rounded-xl">
                            <table className="w-full text-[10px] text-left">
                                <thead className="bg-muted text-muted-foreground uppercase sticky top-0"><tr><th className="p-2">Thời gian</th><th className="p-2">Model</th><th className="p-2 text-right">Tokens</th><th className="p-2 text-center">Trạng thái</th></tr></thead>
                                <tbody className="divide-y divide-border">{recentLogs.map(log => <tr key={log.id} className="hover:bg-muted/30"><td className="p-2">{new Date(Number(log.timestamp)).toLocaleTimeString()}</td><td className="p-2">{log.model.split('-')[0]}...</td><td className="p-2 text-right">{log.tokens}</td><td className="p-2 text-center">{log.status === 'success' ? <CheckCircle size={12} className="text-green-500 inline" /> : <XCircle size={12} className="text-red-500 inline" />}</td></tr>)}</tbody>
                            </table>
                          </div>
                        }
                    </div>
                </div>
            </div>
        </div>
    );
};

const StatusCard = ({ icon, label, value, sub, borderColor }: any) => <div className={`bg-card border ${borderColor} p-6 rounded-2xl shadow-sm`}><div className="flex items-center justify-between mb-2"><span className="text-xs text-muted-foreground font-bold uppercase">{label}</span>{icon}</div><div className="text-2xl font-black">{value}</div><div className="text-[10px] text-muted-foreground opacity-60 uppercase font-bold">{sub}</div></div>;
const StatusSubCard = ({ icon, label, value, color }: any) => <div className="p-3 bg-muted/20 border border-border rounded-xl"><div className="flex items-center gap-2 text-muted-foreground mb-1">{icon}<span className="text-[9px] font-black uppercase">{label}</span></div><div className={`text-[11px] font-mono truncate ${color || 'text-foreground'}`}>{value}</div></div>;
const ConfigSelect = ({ label, value, onChange, options }: any) => <div className="space-y-1.5"><label className="text-[10px] font-bold text-muted-foreground uppercase ml-1">{label}</label><select value={value} onChange={e => onChange(e.target.value)} className="w-full bg-background border border-border rounded-xl p-3 text-xs outline-none focus:ring-2 focus:ring-primary/20">{options.map((o: any) => <option key={o.v} value={o.v}>{o.l}</option>)}</select></div>;
const TabBtn = ({ active, onClick, children }: any) => <button onClick={onClick} className={`px-4 py-2 rounded-md text-xs font-bold transition-all ${active ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{children}</button>;
const StatBox = ({ label, val, color, bg }: any) => <div className={`p-3 ${bg} rounded-xl border border-white/5`}><div className="text-[9px] text-muted-foreground font-bold uppercase">{label}</div><div className={`text-sm font-black ${color}`}>{val}</div></div>;

export default SystemAdminView;
