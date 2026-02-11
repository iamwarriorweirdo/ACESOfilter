import React, { useState } from 'react';
import { UploadCloud, FileText, FileSpreadsheet, Image as ImageIcon, File as FileIcon, Loader2, Trash2, Search, Download, FileType, Bot, X, RefreshCcw, Users, Maximize2, Minimize2, Folder, FolderPlus, Edit3, Home, ChevronRight, LayoutGrid, Server, LogOut, Sun, Moon, Globe } from 'lucide-react';
import { Document, Language, Message, UserRole, ChatSession, Folder as FolderType, SystemConfig, Theme } from '../types';
import { TRANSLATIONS } from '../constants';
import ChatInterface from './ChatInterface';
import UserManagementDialog from './UserManagementDialog';
import SystemAdminView from './SystemAdminView';

interface AdminViewProps {
    documents: Document[];
    folders: FolderType[];
    onCreateFolder: (name: string, parentId: string | null) => void;
    onRenameFolder: (id: string, name: string) => void;
    onDeleteFolder: (id: string) => void;
    isUploading: boolean;
    onUpload: (e: React.ChangeEvent<HTMLInputElement>, folderId: string | null) => void;
    onClearDocs: () => void;
    onEditDoc: (doc: Document) => void;
    onDeleteDoc: (docId: string) => void;
    language: Language;
    setLanguage: (lang: Language) => void; 
    messages?: Message[];
    isLoading?: boolean;
    input?: string;
    onInputChange?: (val: string) => void;
    onSubmit?: (e: React.FormEvent) => void;
    onClearChat?: () => void;
    currentUserRole: UserRole;
    currentUsername: string;
    sessions: ChatSession[];
    currentSessionId: string | null;
    onNewChat: () => void;
    onSelectSession: (session: ChatSession) => void;
    onDeleteSession: (sessionId: string) => void;
    config?: SystemConfig;
    setConfig?: (config: SystemConfig) => void;
    theme: Theme; 
    toggleTheme: () => void; 
    onLogout: () => void; 
}

const AdminView: React.FC<AdminViewProps> = ({
    documents,
    folders,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    isUploading,
    onUpload,
    onEditDoc,
    onDeleteDoc,
    language,
    setLanguage,
    messages = [],
    isLoading = false,
    input = '',
    onInputChange = () => { },
    onSubmit = (e) => e.preventDefault(),
    currentUserRole,
    currentUsername,
    sessions,
    currentSessionId,
    onNewChat,
    onSelectSession,
    onDeleteSession,
    config,
    setConfig,
    theme,
    toggleTheme,
    onLogout
}) => {
    const t = (TRANSLATIONS as any)[language] || TRANSLATIONS.en;
    const [activeTab, setActiveTab] = useState<'docs' | 'users' | 'system'>('docs');
    const [searchTerm, setSearchTerm] = useState('');
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [isChatFull, setIsChatFull] = useState(true);
    const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);

    // Dialog States
    const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
    const [editFolderName, setEditFolderName] = useState('');

    // UI Deleting States
    const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
    const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);

    const isSuperAdminOrIT = currentUserRole === 'superadmin' || currentUserRole === 'it';

    const getLocalizedFolderName = (name: string) => {
        const key = name.toLowerCase().replace(/\s+/g, '_');
        return (t[name] || t[key] || name);
    };

    const currentFolder = folders.find(f => f.id === currentFolderId);

    const getBreadcrumbs = () => {
        const crumbs = [];
        let curr = currentFolder;
        while (curr) {
            crumbs.unshift(curr);
            curr = folders.find(f => f.id === curr?.parentId);
        }
        return crumbs;
    };

    const visibleFolders = folders.filter(f => f.parentId === currentFolderId);
    const visibleFiles = documents.filter(doc => {
        if (searchTerm) return doc.name.toLowerCase().includes(searchTerm.toLowerCase());
        return doc.folderId === currentFolderId;
    });

    const handleDownload = (doc: Document) => {
        try {
            const link = document.createElement('a');
            link.href = doc.content;
            link.download = doc.name;
            link.target = '_blank';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (error) { console.error(error); }
    };

    const getFileIcon = (doc: Document) => {
        const type = doc.type.toLowerCase();
        const name = doc.name.toLowerCase();
        if (type.includes('image')) return <ImageIcon />;
        if (type.includes('pdf')) return <FileType />;
        if (type.includes('sheet') || type.includes('excel') || name.endsWith('.xlsx')) return <FileSpreadsheet />;
        if (type.includes('word') || type.includes('officedocument') || name.endsWith('.docx')) return <FileText className="text-blue-400" />;
        return <FileIcon />;
    };

    const submitCreateFolder = (e: React.FormEvent) => {
        e.preventDefault();
        if (newFolderName.trim()) {
            onCreateFolder(newFolderName, currentFolderId);
            setNewFolderName('');
            setIsCreateFolderOpen(false);
        }
    };

    const submitRenameFolder = (e: React.FormEvent) => {
        e.preventDefault();
        if (editFolderName.trim() && editingFolderId) {
            onRenameFolder(editingFolderId, editFolderName);
            setEditingFolderId(null);
            setEditFolderName('');
        }
    };

    const handleDeleteFolderWrapper = async (id: string) => {
        setDeletingFolderId(id);
        await onDeleteFolder(id);
        setDeletingFolderId(null);
    };

    const handleDeleteDocWrapper = async (id: string) => {
        setDeletingDocId(id);
        await onDeleteDoc(id);
        setDeletingDocId(null);
    };

    return (
        <div className="relative min-h-screen w-full flex flex-col overflow-hidden">
            {/* Mesh Background */}
            <div className="mesh-gradient opacity-40 dark:opacity-100" />

            <div className="flex-1 w-full p-4 md:p-8 xl:p-12 overflow-y-auto pb-32 relative z-10">
                <div className="max-w-[1400px] mx-auto space-y-10">

                    {/* Dashboard Header / Command Center */}
                    <div className="glass-panel sticky top-0 z-30 p-4 md:px-8 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-6 shadow-2xl">
                        <div className="flex flex-col lg:flex-row lg:items-center gap-6">
                            <div className="space-y-1">
                                {/* Use text-foreground instead of gradients that might look bad on light mode */}
                                <h2 className="text-3xl font-black text-foreground tracking-tighter">
                                    {t.welcomeAdmin}
                                </h2>
                                <p className="text-[10px] uppercase tracking-[0.2em] font-bold text-primary px-1">System Intelligence Active</p>
                            </div>

                            <div className="flex bg-muted/50 backdrop-blur-md p-1.5 rounded-2xl border border-black/5 dark:border-white/5">
                                <button onClick={() => setActiveTab('docs')} className={`flex items-center gap-2.5 px-6 py-2 rounded-xl text-xs font-black transition-all ${activeTab === 'docs' ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/20 scale-105' : 'text-muted-foreground hover:text-foreground'}`}>
                                    <LayoutGrid size={16} /> {t.tabDocs}
                                </button>
                                <button onClick={() => setActiveTab('users')} className={`flex items-center gap-2.5 px-6 py-2 rounded-xl text-xs font-black transition-all ${activeTab === 'users' ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/20 scale-105 ml-1' : 'text-muted-foreground hover:text-foreground'}`}>
                                    <Users size={16} /> {t.tabUsers}
                                </button>
                                {isSuperAdminOrIT && (
                                    <button onClick={() => setActiveTab('system')} className={`flex items-center gap-2.5 px-6 py-2 rounded-xl text-xs font-black transition-all ${activeTab === 'system' ? 'bg-red-500 text-white shadow-lg shadow-red-500/20 scale-105 ml-1' : 'text-muted-foreground hover:text-foreground'}`}>
                                        <Server size={16} /> {t.tabSystem}
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Header Actions */}
                        <div className="flex items-center gap-4">
                            <div className="flex items-center gap-2 bg-muted/50 rounded-xl p-1 border border-black/5 dark:border-white/5">
                                <button onClick={() => {
                                    const langs: Language[] = ['en', 'vi', 'zh'];
                                    const next = langs[(langs.indexOf(language) + 1) % langs.length];
                                    setLanguage(next);
                                }} className="px-3 py-1.5 rounded-lg hover:bg-background transition-colors text-muted-foreground flex items-center gap-2 font-black text-[10px] uppercase">
                                    <Globe size={14} className="text-primary" /> {language}
                                </button>
                                <button onClick={toggleTheme} className="p-2 rounded-lg hover:bg-background transition-colors text-muted-foreground">
                                    {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
                                </button>
                            </div>
                            <div className="h-6 w-px bg-border"></div>
                            <button onClick={onLogout} className="group relative flex items-center gap-2 px-5 py-2 overflow-hidden bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white rounded-xl transition-all text-xs font-black">
                                <div className="absolute inset-0 bg-red-500 translate-y-full group-hover:translate-y-0 transition-transform duration-300 -z-10" />
                                <LogOut size={14} /> {t.back}
                            </button>
                        </div>
                    </div>

                    <div className="animate-fade-in space-y-8">
                        {activeTab === 'docs' ? (
                            <div className="space-y-8">
                                {/* Upload Section - Glass Dropzone */}
                                <div className="glass-card rounded-[2rem] p-8 border-primary/10 relative group overflow-hidden">
                                    <div className="absolute inset-0 bg-gradient-to-r from-primary/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                                    <div className="flex flex-col md:flex-row items-center justify-between gap-10 relative z-10">
                                        <div className="flex items-center gap-8">
                                            <div className="w-20 h-20 rounded-3xl bg-primary/10 text-primary flex items-center justify-center shrink-0 shadow-inner border border-primary/20 animate-float">
                                                <UploadCloud size={40} strokeWidth={1.5} />
                                            </div>
                                            <div className="space-y-2">
                                                <h3 className="font-black text-2xl tracking-tight text-foreground">{t.uploadTitle}</h3>
                                                <div className="flex items-center gap-2 py-1 px-3 bg-primary/10 rounded-full w-fit border border-primary/10">
                                                    <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                                                    <p className="text-[10px] font-black uppercase text-primary tracking-widest">Target: {currentFolder ? getLocalizedFolderName(currentFolder.name) : "Root Archive"}</p>
                                                </div>
                                            </div>
                                        </div>

                                        <label className="relative flex-1 md:max-w-md h-32 border-2 border-dashed border-primary/20 rounded-3xl bg-white/40 dark:bg-black/20 hover:bg-primary/5 hover:border-primary/40 transition-all cursor-pointer group/upload">
                                            <input type="file" multiple onChange={(e) => onUpload(e, currentFolderId)} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" disabled={isUploading} />
                                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                                                {isUploading ? (
                                                    <div className="flex flex-col items-center gap-2">
                                                        <Loader2 className="w-10 h-10 animate-spin text-primary" />
                                                        <span className="text-[10px] font-black uppercase tracking-widest text-primary">Uploading Matrix...</span>
                                                    </div>
                                                ) : (
                                                    <>
                                                        <div className="flex -space-x-2">
                                                            <div className="w-10 h-10 rounded-xl bg-card border border-border flex items-center justify-center shadow-lg group-hover/upload:-translate-y-2 transition-transform duration-300"><FileText size={20} className="text-blue-500" /></div>
                                                            <div className="w-10 h-10 rounded-xl bg-card border border-border flex items-center justify-center shadow-lg group-hover/upload:-translate-y-1 transition-transform duration-300 delay-75"><ImageIcon size={20} className="text-purple-500" /></div>
                                                            <div className="w-10 h-10 rounded-xl bg-card border border-border flex items-center justify-center shadow-lg group-hover/upload:-translate-y-2 transition-transform duration-300 delay-150"><FileType size={20} className="text-emerald-500" /></div>
                                                        </div>
                                                        <span className="text-xs font-black text-muted-foreground uppercase tracking-widest group-hover/upload:text-foreground transition-colors">{t.dragDrop}</span>
                                                    </>
                                                )}
                                            </div>
                                        </label>
                                    </div>
                                </div>

                                {/* Navigation & Search Bar */}
                                <div className="flex flex-col md:flex-row gap-4 justify-between items-center glass-panel p-2 rounded-2xl border-black/5 dark:border-white/5 shadow-xl">
                                    <div className="flex items-center gap-1.5 px-4 overflow-x-auto no-scrollbar">
                                        <button onClick={() => setCurrentFolderId(null)} className={`p-2.5 rounded-xl hover:bg-muted/40 transition-all ${!currentFolderId ? 'text-primary bg-primary/10 shadow-inner' : 'text-muted-foreground hover:scale-110'}`}><Home size={20} /></button>
                                        {getBreadcrumbs().map((folder) => (
                                            <div key={folder!.id} className="flex items-center gap-1.5 shrink-0">
                                                <ChevronRight size={14} className="text-muted-foreground/30" />
                                                <button onClick={() => setCurrentFolderId(folder!.id)} className="text-xs font-black uppercase tracking-wider hover:text-primary text-foreground px-4 py-2 rounded-xl hover:bg-muted/40 transition-all truncate max-w-[120px] sm:max-w-[200px]">{getLocalizedFolderName(folder!.name)}</button>
                                            </div>
                                        ))}
                                        {currentFolderId && <span className="text-[10px] font-black bg-muted px-2 py-0.5 rounded-full text-muted-foreground ml-2">{visibleFiles.length} ITEM(S)</span>}
                                    </div>
                                    <div className="flex items-center gap-3 w-full md:w-auto p-1">
                                        <div className="relative flex-1 md:w-72 group">
                                            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground group-focus-within:text-primary transition-colors" />
                                            <input type="text" placeholder={t.searchDocs} value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="w-full bg-white/60 dark:bg-black/20 border-none rounded-xl pl-12 pr-4 py-3 text-xs font-bold focus:ring-2 focus:ring-primary/20 outline-none h-11 transition-all text-foreground" />
                                        </div>
                                        {!searchTerm && <button onClick={() => setIsCreateFolderOpen(true)} className="flex items-center gap-3 px-6 py-3 bg-primary text-primary-foreground rounded-xl text-xs font-black hover:opacity-90 hover:scale-105 transition-all whitespace-nowrap h-11 shadow-lg shadow-primary/20"><FolderPlus size={18} /> NEW FOLDER</button>}
                                    </div>
                                </div>

                                {/* Content Area - Bento Grid */}
                                <div className="min-h-[400px] space-y-10">
                                    {!searchTerm && visibleFolders.length > 0 && (
                                        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4">
                                            {visibleFolders.map(folder => (
                                                <div key={folder.id} className="group relative glass-card rounded-3xl p-6 transition-all select-none overflow-hidden aspect-square flex flex-col justify-center items-center">
                                                    <div className="absolute inset-0 bg-gradient-to-b from-blue-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                                                    <div className="cursor-pointer flex flex-col items-center text-center gap-4 relative z-10" onDoubleClick={() => setCurrentFolderId(folder.id)}>
                                                        <div className="relative">
                                                            <Folder size={56} className="text-blue-500 group-hover:scale-110 group-hover:-translate-y-1 transition-all duration-500" fill="currentColor" fillOpacity={0.1} />
                                                            <div className="absolute inset-0 blur-2xl bg-blue-500/20 rounded-full scale-50 opacity-0 group-hover:opacity-100 transition-opacity" />
                                                        </div>
                                                        <div className="w-full space-y-1">
                                                            <div className="font-black text-xs uppercase tracking-tighter truncate w-full text-foreground" title={getLocalizedFolderName(folder.name)}>{getLocalizedFolderName(folder.name)}</div>
                                                            <div className="text-[9px] font-black tracking-widest text-muted-foreground opacity-60 uppercase">{new Date(folder.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
                                                        </div>
                                                    </div>
                                                    <div className="absolute top-2 right-2 flex gap-1 opacity-100 lg:opacity-0 group-hover:opacity-100 transition-all translate-y-2 group-hover:translate-y-0 duration-300">
                                                        <button onClick={(e) => { e.stopPropagation(); setEditingFolderId(folder.id); setEditFolderName(folder.name); }} className="p-2 bg-background hover:bg-blue-500 hover:text-white backdrop-blur-md rounded-xl text-muted-foreground shadow-sm border border-black/5 dark:border-white/5"><Edit3 size={12} /></button>
                                                        <button onClick={(e) => { e.stopPropagation(); handleDeleteFolderWrapper(folder.id); }} className="p-2 bg-background hover:bg-red-500 hover:text-white backdrop-blur-md rounded-xl text-muted-foreground shadow-sm border border-black/5 dark:border-white/5">
                                                            {deletingFolderId === folder.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    <div className="glass-panel rounded-3xl overflow-hidden shadow-2xl border-black/5 dark:border-white/10">
                                        <div className="px-8 py-4 border-b border-border bg-muted/30 flex justify-between items-center text-[10px] font-black text-muted-foreground uppercase tracking-[0.2em] relative overflow-hidden">
                                            <div className="absolute inset-0 bg-gradient-to-r from-primary/5 to-transparent skew-x-12" />
                                            <span className="relative z-10 flex items-center gap-2"><FileType size={12} className="text-primary" /> OBJECT ARCHIVE</span>
                                            <span className="relative z-10 hidden md:inline flex items-center gap-2"><Download size={12} className="text-blue-500" /> ACTIONS & CONTROL</span>
                                        </div>
                                        <div className="divide-y divide-border">
                                            {visibleFiles.length === 0 && visibleFolders.length === 0 ? (
                                                <div className="p-32 text-center space-y-6 relative overflow-hidden">
                                                    <div className="absolute inset-0 bg-gradient-to-b from-primary/5 to-transparent" />
                                                    <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mx-auto opacity-50 relative animate-pulse"><Search size={40} className="text-muted-foreground" /></div>
                                                    <div className="text-muted-foreground italic font-black text-xs uppercase tracking-[0.3em] opacity-50 relative">{t.dbEmpty}</div>
                                                </div>
                                            ) : (
                                                visibleFiles.map((doc) => {
                                                    const isError = doc.status?.toLowerCase().includes("lỗi") || doc.status?.toLowerCase().includes("error");
                                                    const isIndexed = doc.status?.toLowerCase().includes("thành công") || doc.status?.toLowerCase().includes("indexed") || doc.status?.toLowerCase().includes("v3.0");
                                                    
                                                    return (
                                                        <div key={doc.id} onDoubleClick={() => onEditDoc(doc)} className={`px-8 py-6 flex flex-col md:flex-row md:items-center justify-between hover:bg-primary/5 transition-all gap-6 group cursor-pointer select-none relative ${isError ? 'bg-red-500/5' : ''}`}>
                                                            <div className="absolute inset-0 bg-gradient-to-r from-primary/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                                                            <div className="flex items-center gap-6 min-w-0 relative z-10">
                                                                <div className="w-14 h-14 rounded-2xl bg-card border border-border flex items-center justify-center shrink-0 shadow-sm group-hover:scale-110 group-hover:-rotate-3 transition-all duration-500">
                                                                    <div className="text-primary group-hover:scale-110 transition-transform">{getFileIcon(doc)}</div>
                                                                </div>
                                                                <div className="min-w-0 space-y-1.5">
                                                                    <div className="font-black text-sm lg:text-base truncate text-foreground tracking-tight group-hover:text-primary transition-colors flex items-center gap-2">
                                                                        {doc.name}
                                                                        {isError && <span className="bg-red-500/10 text-red-500 text-[8px] px-1.5 py-0.5 rounded-full border border-red-500/20 font-black">FAILED</span>}
                                                                    </div>
                                                                    <div className="text-[10px] text-muted-foreground flex flex-wrap gap-3 items-center font-black uppercase tracking-widest opacity-80">
                                                                        <span className="text-blue-600 bg-blue-500/10 px-2 py-0.5 rounded-md border border-blue-500/10">{(doc.size / 1024).toFixed(1)} KB</span>
                                                                        <div className="w-1 h-1 rounded-full bg-border" />
                                                                        <span>{new Date(doc.uploadDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                                                                        {searchTerm && <div className="flex items-center gap-2"><div className="w-1 h-1 rounded-full bg-border" /><span className="text-indigo-500 font-black">ARCHIVE: {getLocalizedFolderName(folders.find(f => f.id === doc.folderId)?.name || 'Root')}</span></div>}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            <div className="flex items-center gap-3 self-end md:self-auto opacity-100 lg:opacity-0 group-hover:opacity-100 transition-all translate-x-4 lg:translate-x-12 group-hover:translate-x-0 duration-500 z-10">
                                                                {(isError || isIndexed) && (
                                                                    <button onClick={(e) => { e.stopPropagation(); onEditDoc(doc); }} className="p-3 rounded-2xl hover:bg-orange-500/20 text-orange-500 transition-all border border-black/5 dark:border-white/5 bg-background/50 backdrop-blur-md shadow-lg" title="View Diagnostic Metadata"><Search size={18} /></button>
                                                                )}
                                                                <button onClick={(e) => { e.stopPropagation(); handleDownload(doc); }} className="p-3 rounded-2xl hover:bg-muted/40 text-muted-foreground hover:text-foreground transition-all border border-black/5 dark:border-white/5 bg-background/50 backdrop-blur-md shadow-lg" title="Download Archive"><Download size={18} /></button>
                                                                <button onClick={(e) => { e.stopPropagation(); onEditDoc(doc); }} className="px-8 py-3 rounded-2xl bg-primary text-primary-foreground font-black text-xs tracking-widest hover:scale-105 hover:shadow-primary/30 active:scale-95 transition-all shadow-xl shadow-primary/20 uppercase">{t.edit}</button>
                                                                <button onClick={(e) => { e.stopPropagation(); handleDeleteDocWrapper(doc.id); }} className="p-3 rounded-2xl hover:bg-red-500/20 text-muted-foreground hover:text-red-500 transition-all border border-black/5 dark:border-white/5 bg-background/50 backdrop-blur-md shadow-lg">
                                                                    {deletingDocId === doc.id ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                                                                </button>
                                                            </div>
                                                        </div>
                                                    );
                                                })
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ) : activeTab === 'users' ? (
                            <div className="h-[800px] glass-panel rounded-[3rem] overflow-hidden shadow-2xl p-4 border-black/5 dark:border-white/5 relative z-10">
                                <UserManagementDialog isOpen={true} isInline={true} currentUserRole={currentUserRole} currentUsername={currentUsername} />
                            </div>
                        ) : (
                            <div className="h-full relative z-10">
                                {config && setConfig && <SystemAdminView config={config} setConfig={setConfig} documents={documents} language={language} currentUsername={currentUsername} isEmbedded={true} />}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Floating AI Assistant Trigger */}
            {!isChatOpen && (
                <div className="fixed bottom-12 right-12 z-40 group">
                    <div className="absolute inset-0 bg-primary blur-3xl opacity-20 group-hover:opacity-40 transition-opacity" />
                    <button onClick={() => setIsChatOpen(true)} className="flex items-center gap-5 px-10 py-6 bg-primary hover:bg-primary/90 text-white rounded-[2.5rem] shadow-[0_20px_50px_rgba(99,102,241,0.4)] transition-all hover:scale-110 active:scale-90 relative overflow-hidden border border-white/20">
                        <div className="absolute inset-0 bg-white/20 -translate-x-full group-hover:translate-x-0 transition-transform duration-700 skew-x-12" />
                        <Bot size={32} className="animate-float" />
                        <span className="font-black text-2xl tracking-tighter uppercase">{t.aiAssistant}</span>
                    </button>
                </div>
            )}

            {/* AI Chat Drawer - Higher Fidelity */}
            <div className={`fixed z-50 bg-card/90 backdrop-blur-3xl border-l border-border shadow-[0_0_100px_rgba(0,0,0,0.5)] transform transition-all duration-500 cubic-bezier(0.4, 0, 0.2, 1) flex flex-col ${isChatOpen ? 'translate-x-0' : 'translate-x-full'} ${isChatFull ? 'inset-0 w-full' : 'inset-y-0 right-0 w-full md:w-[500px] lg:w-[35%]'}`}>
                <div className="h-20 border-b border-border flex items-center justify-between px-8 bg-muted/30 shrink-0">
                    <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center text-primary shadow-inner border border-primary/10">
                            <Bot size={24} />
                        </div>
                        <div className="flex flex-col">
                            <span className="font-black text-lg tracking-tight leading-none uppercase text-foreground">{t.aiAssistant}</span>
                            <span className="text-[10px] font-black tracking-widest text-primary/80 uppercase">Root Matrix System</span>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={() => setIsChatFull(!isChatFull)} className="p-3 hover:bg-muted rounded-xl text-muted-foreground hover:text-foreground transition-all hidden md:block">{isChatFull ? <Minimize2 size={20} /> : <Maximize2 size={20} />}</button>
                        <button onClick={onNewChat} className="p-3 hover:bg-muted rounded-xl text-muted-foreground hover:text-foreground transition-all" title={t.newChat}><RefreshCcw size={20} /></button>
                        <div className="w-px h-6 bg-border mx-2" />
                        <button onClick={() => setIsChatOpen(false)} className="p-3 hover:bg-red-500/10 rounded-xl text-muted-foreground hover:text-red-500 transition-all"><X size={24} /></button>
                    </div>
                </div>
                <div className="flex-1 overflow-hidden">
                    <ChatInterface messages={messages} isLoading={isLoading} input={input} onInputChange={onInputChange} onSubmit={onSubmit} hasContext={documents.length > 0} documents={documents} onViewDocument={onEditDoc ? (filename) => { const doc = documents.find(d => d.name === filename); if (doc) onEditDoc(doc); } : undefined} sessions={sessions} currentSessionId={currentSessionId} onNewChat={onNewChat} onSelectSession={onSelectSession} onDeleteSession={onDeleteSession} language={language} />
                </div>
            </div>

            {isChatOpen && <div className="fixed inset-0 bg-black/60 backdrop-blur-md z-40 md:hidden" onClick={() => setIsChatOpen(false)} />}

            {/* Modern Glass Dialogs */}
            {isCreateFolderOpen && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-xl animate-fade-in">
                    <form onSubmit={submitCreateFolder} className="bg-card glass-panel p-10 rounded-[3rem] w-full max-w-md border-border shadow-2xl space-y-8 animate-slide-up">
                        <div className="flex flex-col items-center text-center gap-4">
                            <div className="w-20 h-20 rounded-3xl bg-primary/10 flex items-center justify-center text-primary shadow-inner border border-primary/20">
                                <FolderPlus size={40} />
                            </div>
                            <div className="space-y-1">
                                <h3 className="font-black text-2xl tracking-tighter uppercase text-foreground">Initialize Archive</h3>
                                <p className="text-xs font-black tracking-widest text-muted-foreground uppercase opacity-60">Create a new sector in the database</p>
                            </div>
                        </div>
                        <input autoFocus type="text" value={newFolderName} onChange={e => setNewFolderName(e.target.value)} placeholder="Sector Name..." className="w-full bg-muted/50 border border-border rounded-2xl px-6 py-5 text-lg font-black tracking-tight focus:ring-4 focus:ring-primary/20 outline-none transition-all placeholder:text-muted-foreground/30 text-foreground" />
                        <div className="flex items-center gap-4 pt-2">
                            <button type="button" onClick={() => setIsCreateFolderOpen(false)} className="flex-1 px-4 py-4 text-xs font-black uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors">Abort</button>
                            <button type="submit" className="flex-1 px-4 py-4 bg-primary text-primary-foreground rounded-2xl text-xs font-black uppercase tracking-[0.2em] shadow-lg shadow-primary/20 hover:scale-105 active:scale-95 transition-all">Execute</button>
                        </div>
                    </form>
                </div>
            )}
            {editingFolderId && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-xl animate-fade-in">
                    <form onSubmit={submitRenameFolder} className="bg-card glass-panel p-10 rounded-[3rem] w-full max-w-md border-border shadow-2xl space-y-8 animate-slide-up">
                        <div className="flex flex-col items-center text-center gap-4">
                            <div className="w-20 h-20 rounded-3xl bg-blue-500/10 flex items-center justify-center text-blue-500 shadow-inner border border-blue-500/20">
                                <Edit3 size={40} />
                            </div>
                            <div className="space-y-1">
                                <h3 className="font-black text-2xl tracking-tighter uppercase text-foreground">Modify Metadata</h3>
                                <p className="text-xs font-black tracking-widest text-muted-foreground uppercase opacity-60">Rename system sector identifier</p>
                            </div>
                        </div>
                        <input autoFocus type="text" value={editFolderName} onChange={e => setEditFolderName(e.target.value)} className="w-full bg-muted/50 border border-border rounded-2xl px-6 py-5 text-lg font-black tracking-tight focus:ring-4 focus:ring-blue-500/20 outline-none transition-all text-foreground" />
                        <div className="flex items-center gap-4 pt-2">
                            <button type="button" onClick={() => setEditingFolderId(null)} className="flex-1 px-4 py-4 text-xs font-black uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
                            <button type="submit" className="flex-1 px-4 py-4 bg-blue-500 text-white rounded-2xl text-xs font-black uppercase tracking-[0.2em] shadow-lg shadow-blue-500/20 hover:scale-105 active:scale-95 transition-all">Update</button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
};

export default AdminView;