import React, { useState } from 'react';
import { Document, Language, Message, ChatSession, Folder as FolderType, Theme } from '../types';
import ChatInterface from './ChatInterface';
import { TRANSLATIONS } from '../constants';
import { Search, FileText, FileSpreadsheet, Image as ImageIcon, File as FileIcon, Download, Bot, X, FileType, RefreshCcw, Maximize2, Minimize2, Folder, ArrowLeft, Home, ChevronRight, Eye, Globe, Sun, Moon, LogOut } from 'lucide-react';

interface UserViewProps {
    documents: Document[];
    folders: FolderType[];
    messages: Message[];
    isLoading: boolean;
    input: string;
    onInputChange: (val: string) => void;
    onSubmit: (e: React.FormEvent) => void;
    hasContext: boolean;
    language: Language;
    setLanguage: (lang: Language) => void; 
    onClearChat: () => void;
    onViewDocument: (filename: string) => void;
    sessions: ChatSession[];
    currentSessionId: string | null;
    onNewChat: () => void;
    onSelectSession: (session: ChatSession) => void;
    onDeleteSession: (sessionId: string) => void;
    theme: Theme; 
    toggleTheme: () => void; 
    onLogout: () => void; 
    currentUser: any;
}

const UserView: React.FC<UserViewProps> = ({
    documents,
    folders,
    messages,
    isLoading,
    input,
    onInputChange,
    onSubmit,
    hasContext,
    language,
    setLanguage,
    onClearChat,
    onViewDocument,
    sessions,
    currentSessionId,
    onNewChat,
    onSelectSession,
    onDeleteSession,
    theme,
    toggleTheme,
    onLogout,
    currentUser
}) => {
    const t = (TRANSLATIONS as any)[language] || TRANSLATIONS.en;
    const [searchTerm, setSearchTerm] = useState('');
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [isChatFull, setIsChatFull] = useState(true);

    // Navigation State
    const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);

    // Logic lọc dữ liệu
    const visibleFolders = folders.filter(f => f.parentId === currentFolderId);
    const visibleFiles = documents.filter(doc => {
        if (searchTerm) return doc.name.toLowerCase().includes(searchTerm.toLowerCase());
        return doc.folderId === currentFolderId;
    });

    // Breadcrumbs
    const getBreadcrumbs = () => {
        const crumbs = [];
        let curr = folders.find(f => f.id === currentFolderId);
        while (curr) {
            crumbs.unshift(curr);
            curr = folders.find(f => f.id === curr?.parentId);
        }
        return crumbs;
    };

    const handleDownload = (doc: Document) => {
        try {
            if (doc.content.startsWith('data:')) {
                const link = window.document.createElement('a');
                link.href = doc.content;
                link.download = doc.name;
                window.document.body.appendChild(link);
                link.click();
                window.document.body.removeChild(link);
            } else {
                const a = window.document.createElement('a');
                a.href = doc.content;
                a.download = doc.name;
                window.document.body.appendChild(a);
                a.click();
                window.document.body.removeChild(a);
            }
        } catch (error) { alert("Download failed"); }
    };

    const getFileIcon = (doc: Document) => {
        const type = doc.type.toLowerCase();
        const name = doc.name.toLowerCase();
        if (type.includes('image')) return <ImageIcon className="text-purple-500" />;
        if (type.includes('pdf')) return <FileType className="text-red-500" />;
        if (type.includes('sheet') || type.includes('excel') || name.endsWith('.xlsx')) return <FileSpreadsheet className="text-green-500" />;
        if (type.includes('word') || type.includes('document') || name.endsWith('.docx')) return <FileText className="text-blue-500" />;
        return <FileIcon className="text-gray-500" />;
    };

    return (
        <div className="relative min-h-screen w-full flex flex-col overflow-hidden">
            {/* Mesh Background */}
            <div className="mesh-gradient opacity-40 dark:opacity-100" />

            <div className="flex-1 p-6 md:p-12 overflow-y-auto pb-32 scroll-smooth relative z-10">
                <div className="max-w-[1400px] mx-auto space-y-12">

                    {/* Header Section - Premium Floating */}
                    <div className="glass-panel sticky top-0 z-30 p-6 md:px-10 rounded-[2rem] flex flex-col md:flex-row justify-between items-center gap-8 shadow-2xl border-black/5 dark:border-white/5">
                        <div className="flex flex-col gap-1 items-center md:items-start text-center md:text-left">
                            <h2 className="text-4xl font-black text-foreground tracking-tighter">
                                {t.welcomeUser}
                            </h2>
                            <div className="flex items-center gap-2">
                                <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                                <p className="text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground">{t.userDesc}</p>
                            </div>
                        </div>

                        <div className="flex items-center gap-4 bg-muted/50 p-1.5 rounded-2xl border border-black/5 dark:border-white/5">
                            <button onClick={() => {
                                const langs: Language[] = ['en', 'vi', 'zh'];
                                const next = langs[(langs.indexOf(language) + 1) % langs.length];
                                setLanguage(next);
                            }} className="px-4 py-2 rounded-xl hover:bg-background transition-all text-muted-foreground flex items-center gap-2 font-black text-[10px] uppercase">
                                <Globe size={16} className="text-primary" /> {language}
                            </button>
                            <button onClick={toggleTheme} className="p-2.5 rounded-xl hover:bg-background transition-all text-muted-foreground">
                                {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
                            </button>
                            <div className="h-6 w-px bg-border mx-1"></div>
                            <button onClick={onLogout} className="group relative flex items-center gap-2 px-6 py-2.5 overflow-hidden bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white rounded-xl transition-all text-[10px] font-black uppercase tracking-widest">
                                <div className="absolute inset-0 bg-red-500 translate-y-full group-hover:translate-y-0 transition-transform duration-300 -z-10" />
                                <LogOut size={14} /> {t.back}
                            </button>
                        </div>
                    </div>

                    {/* Navigation & Search Bar */}
                    <div className="flex flex-col md:flex-row gap-6 relative z-20">
                        {/* Breadcrumbs - Glassy */}
                        <div className="flex-1 flex items-center gap-2 glass-panel px-5 py-3 rounded-2xl overflow-x-auto shadow-xl border-black/5 dark:border-white/5">
                            <button
                                onClick={() => setCurrentFolderId(null)}
                                className={`p-2.5 rounded-xl hover:bg-muted/40 transition-all ${!currentFolderId ? 'text-primary bg-primary/10 shadow-inner' : 'text-muted-foreground hover:scale-110'}`}
                            >
                                <Home size={22} />
                            </button>
                            {getBreadcrumbs().map((folder) => (
                                <div key={folder!.id} className="flex items-center gap-2 shrink-0">
                                    <ChevronRight size={14} className="text-muted-foreground/30" />
                                    <button
                                        onClick={() => setCurrentFolderId(folder!.id)}
                                        className="text-[10px] font-black uppercase tracking-widest hover:text-primary px-4 py-2 rounded-xl hover:bg-muted/40 transition-all text-foreground"
                                    >
                                        {folder!.name}
                                    </button>
                                </div>
                            ))}
                            {currentFolderId && <div className="ml-auto px-3 py-1 bg-primary/10 rounded-full text-[10px] font-black text-primary uppercase">{visibleFiles.length} FILES</div>}
                        </div>

                        {/* Search - High Contrast Glass */}
                        <div className="relative group w-full md:w-96">
                            <div className="absolute inset-0 bg-primary/20 blur-2xl opacity-0 group-focus-within:opacity-100 transition-opacity" />
                            <Search className="absolute left-5 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground group-focus-within:text-primary transition-colors z-10" />
                            <input
                                type="text"
                                placeholder={t.searchDocs}
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="w-full glass-panel border-black/5 dark:border-white/10 rounded-2xl pl-14 pr-6 py-4 text-sm font-bold focus:outline-none ring-4 ring-transparent focus:ring-primary/10 transition-all shadow-xl relative z-0 text-foreground"
                            />
                        </div>
                    </div>

                    {/* Content Area */}
                    <div className="min-h-[400px] space-y-12">
                        {/* Visual Folder Grid - Bento Style */}
                        {!searchTerm && visibleFolders.length > 0 && (
                            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6 self-start">
                                {visibleFolders.map(folder => (
                                    <div
                                        key={folder.id}
                                        onDoubleClick={() => setCurrentFolderId(folder.id)}
                                        className="group cursor-pointer glass-card rounded-[2.5rem] p-8 flex flex-col items-center text-center gap-5 aspect-square justify-center relative overflow-hidden"
                                    >
                                        <div className="absolute inset-0 bg-gradient-to-tr from-blue-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                                        <div className="relative">
                                            <Folder size={64} className="text-blue-500 group-hover:scale-110 transition-transform duration-500" fill="currentColor" fillOpacity={0.1} />
                                            <div className="absolute inset-0 blur-2xl bg-blue-500/20 rounded-full scale-50 opacity-0 group-hover:opacity-100 transition-opacity" />
                                        </div>
                                        <span className="text-xs font-black uppercase tracking-widest truncate w-full px-2 text-foreground" title={folder.name}>{folder.name}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* File Archive - Modern Table */}
                        <div className="glass-panel rounded-[2.5rem] overflow-hidden shadow-[0_40px_100px_rgba(0,0,0,0.3)] border-black/5 dark:border-white/5 animate-fade-in relative">
                            <div className="absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent pointer-events-none" />
                            <div className="px-10 py-5 border-b border-border bg-muted/30 flex justify-between items-center relative z-10 uppercase tracking-[0.2em] font-black text-[10px] text-muted-foreground/60">
                                <span className="flex items-center gap-2"><FileType size={12} strokeWidth={3} className="text-primary" /> SECURE STORAGE</span>
                                <span className="px-3 py-1 bg-muted/20 rounded-lg text-primary">{visibleFiles.length} OBJECTS</span>
                            </div>

                            <div className="divide-y divide-border relative z-10">
                                {visibleFiles.length === 0 && visibleFolders.length === 0 ? (
                                    <div className="p-32 text-center flex flex-col items-center gap-6">
                                        <div className="p-8 rounded-full bg-muted/50 animate-pulse text-muted-foreground/20"><Search size={48} /></div>
                                        <div className="text-muted-foreground italic font-black text-xs uppercase tracking-[0.3em] opacity-50 relative">{t.dbEmpty}</div>
                                    </div>
                                ) : (
                                    visibleFiles.map((doc) => {
                                        const isError = doc.status?.toLowerCase().includes("lỗi") || doc.status?.toLowerCase().includes("error");
                                        const isIndexed = doc.status?.toLowerCase().includes("thành công") || doc.status?.toLowerCase().includes("indexed");
                                        
                                        return (
                                        <div
                                            key={doc.id}
                                            onDoubleClick={() => onViewDocument(doc.name)}
                                            className={`group px-10 py-6 flex items-center justify-between hover:bg-primary/5 transition-all gap-8 cursor-pointer select-none relative overflow-hidden ${isError ? 'border-l-4 border-l-red-500' : ''}`}
                                        >
                                            <div className="absolute inset-0 bg-gradient-to-r from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                                            <div className="flex items-center gap-6 flex-1 min-w-0 relative z-10">
                                                <div className="w-14 h-14 rounded-2xl bg-card border border-border flex items-center justify-center shrink-0 shadow-sm group-hover:scale-110 group-hover:-rotate-3 transition-all duration-500">
                                                    <div className="group-hover:scale-110 transition-transform">{getFileIcon(doc)}</div>
                                                </div>
                                                <div className="min-w-0 space-y-1.5">
                                                    <div className="font-black text-base truncate text-foreground group-hover:text-primary transition-colors tracking-tight flex items-center gap-2">
                                                        {doc.name}
                                                        {isError && <span className="bg-red-500/10 text-red-500 text-[8px] px-1.5 py-0.5 rounded-full border border-red-500/20 font-black">FAILED</span>}
                                                    </div>
                                                    <div className="text-[10px] text-muted-foreground flex items-center gap-3 font-black uppercase tracking-widest opacity-80">
                                                        <span className="text-blue-600 bg-blue-500/10 px-2 py-0.5 rounded-md border border-blue-500/10">{(doc.size / 1024).toFixed(0)} KB</span>
                                                        <div className="w-1 h-1 rounded-full bg-border" />
                                                        <span>{new Date(doc.uploadDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                                                        {searchTerm && <span className="text-indigo-500 font-black">ARCHIVE: {folders.find(f => f.id === doc.folderId)?.name || 'Root'}</span>}
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-3 opacity-100 lg:opacity-0 group-hover:opacity-100 transition-all translate-x-4 lg:translate-x-12 group-hover:translate-x-0 duration-500 z-10">
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); onViewDocument(doc.name); }}
                                                    className="flex items-center gap-3 px-6 py-3 rounded-2xl bg-primary text-primary-foreground font-black text-[10px] tracking-[0.2em] hover:scale-105 active:scale-95 transition-all shadow-xl shadow-primary/20 uppercase"
                                                >
                                                    <Eye size={16} /> {t.view || "Inspect"}
                                                </button>
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); handleDownload(doc); }}
                                                    className="p-3 rounded-2xl text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-all border border-black/5 dark:border-white/5 aspect-square"
                                                    title={t.download}
                                                >
                                                    <Download size={20} />
                                                </button>
                                            </div>
                                        </div>
                                    )})
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Floating AI Assistant Trigger */}
            {!isChatOpen && (
                <div className="fixed bottom-12 right-12 z-40 group">
                    <div className="absolute inset-0 bg-primary blur-3xl opacity-20 group-hover:opacity-40 transition-opacity" />
                    <button
                        onClick={() => setIsChatOpen(true)}
                        className="flex items-center gap-5 px-10 py-6 bg-primary hover:bg-primary/90 text-white rounded-[2.5rem] shadow-[0_20px_50px_rgba(99,102,241,0.4)] transition-all hover:scale-110 active:scale-90 relative overflow-hidden border border-white/20"
                    >
                        <div className="absolute inset-0 bg-white/20 -translate-x-full group-hover:translate-y-0 transition-transform duration-700 skew-x-12" />
                        <Bot size={32} className="animate-float" />
                        <span className="font-black text-2xl tracking-tighter uppercase">{t.aiAssistant}</span>
                    </button>
                </div>
            )}

            {/* AI Chat Drawer - User High Fidelity */}
            <div
                className={`fixed z-50 bg-card/90 backdrop-blur-3xl border-l border-border shadow-[0_0_100px_rgba(0,0,0,0.5)] transform transition-all duration-500 cubic-bezier(0.4, 0, 0.2, 1) flex flex-col
          ${isChatOpen ? 'translate-x-0' : 'translate-x-full'}
          ${isChatFull ? 'inset-0 w-full' : 'inset-y-0 right-0 w-full md:w-[500px] lg:w-[35%]'}
        `}
            >
                <div className="h-20 border-b border-border flex items-center justify-between px-8 bg-muted/30 shrink-0">
                    <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center text-primary shadow-inner border border-primary/10">
                            <Bot size={24} />
                        </div>
                        <div className="flex flex-col">
                            <span className="font-black text-lg tracking-tight leading-none uppercase text-foreground">{t.aiAssistant}</span>
                            <span className="text-[10px] font-black tracking-widest text-primary/80 uppercase">Cognitive Stream Active</span>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={() => setIsChatFull(!isChatFull)} className="p-3 hover:bg-muted rounded-xl text-muted-foreground hover:text-foreground transition-all hidden md:block">
                            {isChatFull ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
                        </button>
                        <div className="w-px h-6 bg-border mx-2"></div>
                        <button onClick={onNewChat} className="p-3 hover:bg-muted rounded-xl text-muted-foreground hover:text-foreground transition-all" title={t.newChat}><RefreshCcw size={20} /></button>
                        <button onClick={() => setIsChatOpen(false)} className="p-3 hover:bg-red-500/10 rounded-xl text-muted-foreground hover:text-red-500 transition-all"><X size={24} /></button>
                    </div>
                </div>
                <div className="flex-1 overflow-hidden">
                    <ChatInterface
                        messages={messages} isLoading={isLoading} input={input} onInputChange={onInputChange} onSubmit={onSubmit}
                        hasContext={hasContext} documents={documents} onViewDocument={onViewDocument}
                        sessions={sessions} currentSessionId={currentSessionId} onNewChat={onNewChat} onSelectSession={onSelectSession} onDeleteSession={onDeleteSession}
                        language={language}
                    />
                </div>
            </div>
            {isChatOpen && <div className="fixed inset-0 bg-black/60 backdrop-blur-md z-40 md:hidden" onClick={() => setIsChatOpen(false)} />}
        </div>
    );
};

export default UserView;