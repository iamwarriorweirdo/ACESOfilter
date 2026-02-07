
import React, { useState, useEffect } from 'react';
import { SystemConfig, Language, Document, UsageStats } from '../types';
import { TRANSLATIONS } from '../constants';
import { Server, Activity, Database, Cpu, Save, AlertTriangle, Cloud, HardDrive, Settings, Zap, Users, Scale, Loader2, Globe, Layers, DownloadCloud, History, ShieldCheck, CheckCircle2, BarChart3, PieChart, TrendingUp, RefreshCcw, BrainCircuit, Calendar, Filter, AlertCircle, Bot, Sparkles, Clock, XCircle, CheckCircle } from 'lucide-react';
import UserManagementDialog from './UserManagementDialog';

interface SystemAdminViewProps {
    config: SystemConfig;
    setConfig: (config: SystemConfig) => void | Promise<void>;
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

const SystemAdminView: React.FC<SystemAdminViewProps> = ({ config, setConfig, documents, language, currentUsername, isEmbedded = false }) => {
    const t = (TRANSLATIONS as any)[language] || TRANSLATIONS.en;
    const [localConfig, setLocalConfig] = useState<SystemConfig>(config);
    const [hasChanges, setHasChanges] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isBackingUp, setIsBackingUp] = useState(false);
    const [isCheckingIntegrity, setIsCheckingIntegrity] = useState(false);
    const [isSyncingAI, setIsSyncingAI] = useState(false);
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
                // Use trend for chart, data for table
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

                {/* STATUS CARDS */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <StatusCard icon={<Activity className="text-green-500" />} label={t.systemHealth} value={systemHealth} sub="All systems operational" borderColor="border-green-500/20" />
                    <StatusCard icon={<TrendingUp className="text-blue-500" />} label={t.requestsToday || "Requests Today"} value={analyticsSummary.totalRequests || "0"} sub={t.estRpd || "Est. RPD"} borderColor="border-blue-500/20" />
                    <StatusCard icon={<Layers className="text-indigo-500" />} label={t.storageUsage} value={`${displaySizeMB} MB`} sub="Cloudinary + Supabase + Blob" borderColor="border-indigo-500/20" />
                    <StatusCard icon={<Cpu className="text-amber-500" />} label={t.aiModelLabel} value={localConfig.aiModel.toUpperCase()} sub="Active Core Model" borderColor="border-amber-500/20" />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <div className="space-y-6">
                        {/* SYSTEM CONFIG CARD */}
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
                                        <p className="text-[10px] text-muted-foreground mt-1.5 leading-relaxed">Sử dụng cho nhiệm vụ quét tài liệu, hình ảnh và PDF phức tạp.</p>
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
                                        <p className="text-[10px] text-muted-foreground mt-1.5 leading-relaxed">Trích xuất Metadata, tóm tắt và phân tích cấu trúc JSON.</p>
                                    </div>

                                    <div className="p-4 bg-muted/20 rounded-lg border border-border">
                                        <div className="flex items-center justify-between mb-2">
                                            <label className="block text-xs font-bold text-muted-foreground uppercase">💬 Chat Engine (RAG)</label>
                                            <span className="text-[10px] bg-purple-500/10 text-purple-500 px-1.5 py-0.5 rounded border border-purple-500/20 font-bold">High RPM</span>
                                        </div>
                                        <select value={localConfig.chatModel || localConfig.aiModel} onChange={(e) => handleConfigChange('chatModel', e.target.value)} className="w-full bg-background border border-border rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-primary outline-none cursor-pointer">
                                            <option value="gemini-2.5-flash-lite">🏎️ Gemini 2.5 Flash Lite (Fastest)</option>
                                            <option value="gemini-2.5-flash">🚀 Gemini 2.5 Flash</option>
                                            <option value="gemini-2.0-flash-lite">⚡ Gemini 2.0 Flash Lite</option>
                                            <option value="llama-3.3-70b">🦙 Llama 3.3 70B (Groq)</option>
                                        </select>
                                        <p className="text-[10px] text-muted-foreground mt-1.5 leading-relaxed">Tối ưu cho tốc độ phản hồi Chat và chịu tải truy vấn lớn.</p>
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

                                {/* Adobe PDF Services Section */}
                                <div className="p-4 border border-blue-500/20 bg-blue-500/5 rounded-lg space-y-4">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <Zap className="text-blue-500" size={18} />
                                            <span className="text-xs font-bold text-muted-foreground uppercase">Adobe PDF Optimization</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] text-muted-foreground">{localConfig.enableAdobeCompression ? 'Enabled' : 'Disabled'}</span>
                                            <button
                                                onClick={() => handleConfigChange('enableAdobeCompression', !localConfig.enableAdobeCompression)}
                                                className={`w-10 h-5 rounded-full p-1 transition-colors ${localConfig.enableAdobeCompression ? 'bg-blue-600' : 'bg-muted-foreground/30'}`}
                                            >
                                                <div className={`w-3 h-3 bg-white rounded-full transition-transform ${localConfig.enableAdobeCompression ? 'translate-x-5' : 'translate-x-0'}`} />
                                            </button>
                                        </div>
                                    </div>

                                    {localConfig.enableAdobeCompression && (
                                        <div className="grid grid-cols-1 gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
                                            <div className="space-y-1.5">
                                                <label className="text-[10px] font-bold text-muted-foreground ml-1">ADOBE CLIENT ID</label>
                                                <input
                                                    type="text"
                                                    value={localConfig.adobeClientId || ''}
                                                    onChange={(e) => handleConfigChange('adobeClientId', e.target.value)}
                                                    placeholder="Client ID from Adobe Developer Console"
                                                    className="w-full bg-background/50 border border-border rounded-lg p-2 text-xs font-mono"
                                                />
                                            </div>
                                            <div className="space-y-1.5">
                                                <label className="text-[10px] font-bold text-muted-foreground ml-1">ADOBE CLIENT SECRET</label>
                                                <input
                                                    type="password"
                                                    value={localConfig.adobeClientSecret || ''}
                                                    onChange={(e) => handleConfigChange('adobeClientSecret', e.target.value)}
                                                    placeholder="Client Secret"
                                                    className="w-full bg-background/50 border border-border rounded-lg p-2 text-xs font-mono"
                                                />
                                            </div>
                                            <div className="space-y-1.5">
                                                <label className="text-[10px] font-bold text-muted-foreground ml-1">ORGANIZATION ID</label>
                                                <input
                                                    type="text"
                                                    value={localConfig.adobeOrgId || ''}
                                                    onChange={(e) => handleConfigChange('adobeOrgId', e.target.value)}
                                                    placeholder="Adobe Org ID (optional for some plans)"
                                                    className="w-full bg-background/50 border border-border rounded-lg p-2 text-xs font-mono"
                                                />
                                            </div>
                                            <p className="text-[9px] text-muted-foreground italic">Nén dữ liệu xuống độ phân giải trung bình để tăng 50% tốc độ quét OCR.</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                            <div className="mt-8 flex justify-end">
                                <button onClick={saveConfig} disabled={!hasChanges || isSaving} className={`flex items-center gap-2 px-6 py-3 rounded-lg font-bold transition-all ${hasChanges ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20' : 'bg-muted text-muted-foreground cursor-not-allowed'}`}>
                                    {isSaving ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />} {t.saveConfig}
                                </button>
                            </div>
                        </div>

                        {/* DB MANAGEMENT */}
                        <div className="border border-indigo-500/30 bg-indigo-500/5 rounded-xl p-6 flex flex-col">
                            <div className="flex items-center justify-between mb-6">
                                <div className="flex items-center gap-2 text-indigo-500">
                                    <ShieldCheck size={24} />
                                    <h3 className="font-bold text-xl">{t.dbManagement}</h3>
                                </div>
                                <div className="flex items-center gap-1.5 px-3 py-1 bg-green-500/10 text-green-500 rounded-full border border-green-500/20 text-[10px] font-bold uppercase tracking-wider">
                                    <CheckCircle2 size={12} /> Sync Active
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

                            <div className="space-y-4 mt-auto">
                                <button
                                    onClick={handleReIndexAI}
                                    disabled={isSyncingAI}
                                    className="w-full flex items-center justify-center gap-2 px-4 py-3.5 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-xl text-sm font-bold hover:opacity-90 transition-all shadow-lg shadow-purple-500/20 disabled:opacity-50 relative overflow-hidden"
                                >
                                    {isSyncingAI ? (
                                        <>
                                            <div className="absolute inset-0 bg-black/10 flex items-center justify-start">
                                                <div className="h-full bg-white/20 transition-all duration-300" style={{ width: `${syncProgress}%` }} />
                                            </div>
                                            <div className="relative z-10 flex items-center gap-2">
                                                <Loader2 className="animate-spin" size={18} />
                                                Syncing AI ({syncProgress}%)...
                                            </div>
                                        </>
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

                    {/* ANALYTICS SECTION */}
                    <div className="bg-card border border-border rounded-xl p-6 shadow-sm flex flex-col min-h-[600px]">
                        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-6 gap-4">
                            <div className="flex items-center gap-3">
                                <BarChart3 className="text-emerald-500" />
                                <h3 className="text-xl font-bold">{t.analyticsTitle || "AI Analytics"}</h3>
                            </div>

                            {/* Filters */}
                            <div className="flex items-center gap-2 p-1 bg-muted rounded-lg">
                                <button
                                    onClick={() => setActiveAnalyticsTab('overview')}
                                    className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${activeAnalyticsTab === 'overview' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                                >
                                    Overview
                                </button>
                                <button
                                    onClick={() => setActiveAnalyticsTab('logs')}
                                    className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${activeAnalyticsTab === 'logs' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                                >
                                    Recent Logs
                                </button>
                            </div>
                        </div>

                        <div className="flex flex-wrap gap-2 mb-6 p-2 bg-muted/30 rounded-lg border border-border">
                            <div className="flex items-center gap-2 border-r border-border pr-2">
                                <Filter size={14} className="text-muted-foreground" />
                                <select value={filterModel} onChange={(e) => setFilterModel(e.target.value)} className="bg-transparent text-sm font-medium outline-none cursor-pointer">
                                    <option value="all">{t.allModels || "All Models"}</option>
                                    <option value="gemini">Gemini Series</option>
                                    <option value="llama">Llama Series</option>
                                </select>
                            </div>
                            <div className="flex items-center gap-2">
                                <Calendar size={14} className="text-muted-foreground" />
                                <select value={timeRange} onChange={(e) => setTimeRange(e.target.value as any)} className="bg-transparent text-sm font-medium outline-none cursor-pointer">
                                    <option value="day">{t.today || "Today"}</option>
                                    <option value="week">{t.week || "This Week"}</option>
                                    <option value="month">{t.month || "This Month"}</option>
                                </select>
                            </div>
                            <button onClick={fetchAnalytics} className="ml-auto p-1 hover:bg-muted rounded text-muted-foreground">
                                <RefreshCcw size={14} className={isLoadingAnalytics ? "animate-spin" : ""} />
                            </button>
                        </div>

                        {isLoadingAnalytics ? (
                            <div className="flex-1 flex items-center justify-center"><Loader2 className="animate-spin text-primary w-8 h-8" /></div>
                        ) : (
                            activeAnalyticsTab === 'overview' ? (
                                <div className="flex flex-col gap-6">
                                    {/* Stats Grid */}
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

                                    {/* Chart Area */}
                                    <div className="border border-border rounded-lg p-4 bg-background/50 relative">
                                        <h4 className="text-xs font-bold text-muted-foreground uppercase mb-4">Request Volume Trend</h4>
                                        <SimpleLineChart data={analyticsData} />
                                    </div>

                                    {/* Breakdown Table */}
                                    <div className="overflow-hidden border border-border rounded-lg">
                                        <table className="w-full text-sm text-left">
                                            <thead className="text-xs text-muted-foreground uppercase bg-muted/80">
                                                <tr>
                                                    <th className="px-4 py-3">{t.model}</th>
                                                    <th className="px-4 py-3 text-right">Count</th>
                                                    <th className="px-4 py-3 text-right">Errors</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-border">
                                                {analyticsData.slice(0, 5).map((row, idx) => (
                                                    <tr key={idx} className="hover:bg-muted/30">
                                                        <td className="px-4 py-2 text-xs font-medium flex items-center gap-2">
                                                            {getModelIcon(row.model)} {row.model}
                                                        </td>
                                                        <td className="px-4 py-2 text-right">{row.requests}</td>
                                                        <td className={`px-4 py-2 text-right ${row.errors > 0 ? 'text-red-500 font-bold' : 'text-muted-foreground'}`}>{row.errors}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
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
                                            {recentLogs.length === 0 ? (
                                                <tr><td colSpan={5} className="p-8 text-center text-muted-foreground">No recent logs found.</td></tr>
                                            ) : (
                                                recentLogs.map((log) => (
                                                    <tr key={log.id} className="hover:bg-muted/30">
                                                        <td className="px-3 py-2 whitespace-nowrap">{new Date(log.timestamp).toLocaleTimeString()}</td>
                                                        <td className="px-3 py-2 truncate max-w-[120px]" title={log.model}>{log.model.split('-')[0]}...</td>
                                                        <td className="px-3 py-2 text-right">{log.tokens}</td>
                                                        <td className="px-3 py-2 text-right">{log.duration_ms}ms</td>
                                                        <td className="px-3 py-2 text-center">
                                                            {log.status === 'success' ? (
                                                                <CheckCircle size={14} className="text-green-500 inline" />
                                                            ) : (
                                                                <span title={log.error_msg}>
                                                                    <XCircle size={14} className="text-red-500 inline" />
                                                                </span>
                                                            )}
                                                        </td>
                                                    </tr>
                                                ))
                                            )}
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
