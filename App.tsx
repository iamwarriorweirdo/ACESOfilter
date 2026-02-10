import React, { useState, useEffect } from 'react';
import { Document, Folder, Message, ChatSession, UserRole, Language, SystemConfig, Role, Theme } from './types';
import AdminView from './components/AdminView';
import UserView from './components/UserView';
import { TRANSLATIONS } from './constants';
import EditDocumentDialog from './components/EditDocumentDialog';
import { Eye, EyeOff, LogIn, Globe, Moon, Sun, Lock, User as UserIcon } from 'lucide-react';

const safeFetchJson = async (url: string, options?: RequestInit) => {
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            let errorMsg = `Server Error (${response.status})`;
            try {
                const text = await response.text();
                if (response.status === 404 || text.includes('<!DOCTYPE html>') || text.includes('NOT_FOUND')) {
                    errorMsg = `Endpoint not found (404)`;
                } else {
                    try {
                        const json = JSON.parse(text);
                        if (json.error) errorMsg = json.error;
                    } catch {
                        if (text.length < 200) errorMsg = text;
                    }
                }
            } catch (e) { }
            throw new Error(errorMsg);
        }
        return response.json();
    } catch (error: any) {
        if (error.message === 'Failed to fetch') {
            throw new Error("Lỗi kết nối mạng hoặc Server không phản hồi.");
        }
        throw error;
    }
};

const App: React.FC = () => {
    const [view, setView] = useState<'login' | 'dashboard'>('login');
    const [user, setUser] = useState<{ username: string, role: UserRole } | null>(null);
    const [documents, setDocuments] = useState<Document[]>([]);
    const [folders, setFolders] = useState<Folder[]>([]);
    const [language, setLanguage] = useState<Language>('vi');
    const [theme, setTheme] = useState<Theme>('dark');
    const [isUploading, setIsUploading] = useState(false);
    const [config, setConfig] = useState<SystemConfig>({
        maintenanceMode: false,
        allowPublicUpload: false,
        aiModel: 'gemini-3-flash-preview',
        ocrModel: 'gemini-3-flash-preview',
        analysisModel: 'gemini-3-flash-preview',
        chatModel: 'gemini-2.5-flash-lite',
        maxFileSizeMB: 100
    });

    useEffect(() => {
        const loadConfig = async () => {
            try {
                const savedConfig = await safeFetchJson('/api/app?handler=config');
                if (savedConfig && Object.keys(savedConfig).length > 0) {
                    setConfig(prev => ({ ...prev, ...savedConfig }));
                }
            } catch (e: any) { 
                if (e.message && (e.message.includes('404') || e.message.includes('Endpoint not found'))) {
                    console.warn("System config endpoint not found. Using default config.");
                } else {
                    console.error("Failed to load system config:", e); 
                }
            }
        };
        loadConfig();
    }, []);

    const handleSetConfig = async (newConfig: SystemConfig) => {
        setConfig(newConfig);
        try {
            await fetch('/api/app?handler=config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newConfig)
            });
        } catch (e) { console.error("Failed to save config", e); }
    };

    const [showPassword, setShowPassword] = useState(false);
    const [loginError, setLoginError] = useState('');
    const [isLoggingIn, setIsLoggingIn] = useState(false);

    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [input, setInput] = useState('');
    const [editingDoc, setEditingDoc] = useState<Document | null>(null);
    const [uploadResults, setUploadResults] = useState<{ fileName: string; success: boolean; error?: string }[]>([]);
    const [showUploadResultModal, setShowUploadResultModal] = useState(false);

    useEffect(() => {
        const savedUser = localStorage.getItem('aceso_user');
        if (savedUser) {
            try {
                setUser(JSON.parse(savedUser));
                setView('dashboard');
            } catch (e) { }
        }
        const savedLang = localStorage.getItem('aceso_lang') as Language;
        if (savedLang) setLanguage(savedLang);
        const savedTheme = localStorage.getItem('aceso_theme') as Theme;
        if (savedTheme) {
            setTheme(savedTheme);
            if (savedTheme === 'dark') document.documentElement.classList.add('dark');
            else document.documentElement.classList.remove('dark');
        } else {
            document.documentElement.classList.add('dark');
        }
    }, []);

    const toggleTheme = () => {
        const newTheme = theme === 'light' ? 'dark' : 'light';
        setTheme(newTheme);
        localStorage.setItem('aceso_theme', newTheme);
        if (newTheme === 'dark') document.documentElement.classList.add('dark');
        else document.documentElement.classList.remove('dark');
    };

    const handleSetLanguage = (lang: Language) => {
        setLanguage(lang);
        localStorage.setItem('aceso_lang', lang);
    };

    const fetchDocs = async () => {
        try {
            const docs = await safeFetchJson('/api/app?handler=files');
            setDocuments(docs);
        } catch (e) { console.error(e); }
    };

    const fetchFolders = async () => {
        try {
            const data = await safeFetchJson('/api/app?handler=folders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'list' })
            });
            if (data.folders) setFolders(data.folders);
        } catch (e) { console.error(e); }
    };

    useEffect(() => {
        if (user) {
            fetchDocs();
            fetchFolders();
        }
    }, [user]);

    // CHIẾN LƯỢC: Lazy loading - Chỉ fetch nội dung lớn khi cần mở dialog
    const handleOpenEditDoc = async (doc: Document) => {
        setEditingDoc(doc);
        try {
            const details = await safeFetchJson(`/api/app?handler=files&id=${doc.id}`);
            if (details.extracted_content) {
                setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, extractedContent: details.extracted_content } : d));
            }
        } catch (e) {
            console.error("Failed to fetch doc details", e);
        }
    };

    const uploadFileHybrid = async (file: File): Promise<string> => {
        const CLOUDINARY_LIMIT = 10 * 1024 * 1024;
        if (file.size < CLOUDINARY_LIMIT) {
            try {
                const signData = await safeFetchJson('/api/app?handler=sign-cloudinary', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ timestamp: Math.round(Date.now() / 1000) })
                });
                if (signData.cloudName && signData.apiKey && signData.signature) {
                    const formData = new FormData();
                    formData.append('file', file);
                    formData.append('api_key', signData.apiKey);
                    formData.append('timestamp', signData.timestamp);
                    formData.append('signature', signData.signature);
                    formData.append('folder', signData.folder);
                    const uploadRes = await fetch(`https://api.cloudinary.com/v1_1/${signData.cloudName}/auto/upload`, {
                        method: 'POST',
                        body: formData
                    });
                    if (!uploadRes.ok) throw new Error(`Cloudinary upload failed`);
                    const data = await uploadRes.json();
                    return data.secure_url;
                }
            } catch (e) { console.warn("Cloudinary error, fallback to Supabase"); }
        }
        const signData = await safeFetchJson('/api/app?handler=upload-supabase', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: file.name })
        });
        if (!signData.uploadUrl) throw new Error("Supabase Signed URL missing");
        const uploadRes = await fetch(signData.uploadUrl, {
            method: 'PUT',
            body: file,
            headers: { 'Content-Type': 'application/octet-stream' }
        });
        if (!uploadRes.ok) throw new Error(`Supabase Upload Failed`);
        return signData.publicUrl;
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>, folderId: string | null) => {
        if (!e.target.files) return;
        setIsUploading(true);
        setShowUploadResultModal(false);
        const files = Array.from(e.target.files) as File[];
        const results: { fileName: string; success: boolean; error?: string }[] = new Array(files.length);
        const processOne = async (file: File, index: number) => {
            try {
                const url = await uploadFileHybrid(file);
                const docId = Math.random().toString(36).substr(2, 9);
                const newDoc = {
                    id: docId,
                    name: file.name,
                    type: file.type || 'application/octet-stream',
                    content: url,
                    size: file.size,
                    uploadDate: Date.now(),
                    folderId,
                    uploadedBy: user?.username || 'system',
                    extractedContent: 'Đang chờ xử lý (Queued for AI OCR)...'
                };
                await fetch('/api/app?handler=files', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(newDoc)
                });
                await fetch('/api/app?handler=trigger-ingest', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url, fileName: file.name, fileType: file.type, docId })
                });
                fetchDocs();
                results[index] = { fileName: file.name, success: true };
            } catch (err: any) {
                results[index] = { fileName: file.name, success: false, error: err?.message };
            }
        };
        await Promise.all(files.map((file, i) => processOne(file, i)));
        setUploadResults([...results]);
        setShowUploadResultModal(true);
        setIsUploading(false);
    };

    const handleChatSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() || isLoading) return;
        const userMsg: Message = { id: Date.now().toString(), role: Role.USER, content: input, timestamp: Date.now() };
        const newHistory = [...messages, userMsg];
        setMessages(newHistory);
        setInput('');
        setIsLoading(true);
        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: newHistory, config: { aiModel: config.aiModel } })
            });
            if (!response.ok) throw new Error("Chat error");
            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let aiContent = "";
            const aiMsgId = (Date.now() + 1).toString();
            setMessages(prev => [...prev, { id: aiMsgId, role: Role.MODEL, content: "", timestamp: Date.now() }]);
            while (reader) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                aiContent += chunk;
                setMessages(prev => prev.map(m => m.id === aiMsgId ? { ...m, content: aiContent } : m));
            }
        } catch (err) { console.error(err); } finally { setIsLoading(false); }
    };

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoginError('');
        setIsLoggingIn(true);
        const form = e.target as HTMLFormElement;
        const username = (form.elements.namedItem('username') as HTMLInputElement).value;
        const password = (form.elements.namedItem('password') as HTMLInputElement).value;
        try {
            const res = await safeFetchJson('/api/app?handler=users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'login', username, password })
            });
            if (res.success) {
                setUser(res.user);
                localStorage.setItem('aceso_user', JSON.stringify(res.user));
                setView('dashboard');
            }
        } catch (err: any) { setLoginError(err.message); } finally { setIsLoggingIn(false); }
    };

    const handleLogout = () => {
        localStorage.removeItem('aceso_user');
        setUser(null);
        setView('login');
        setDocuments([]);
    };

    if (view === 'login') {
        const t = (TRANSLATIONS as any)[language] || TRANSLATIONS.en;
        return (
            <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-4 relative overflow-hidden">
                <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-500/20 rounded-full blur-[100px]" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-500/20 rounded-full blur-[100px]" />
                <div className="w-full max-w-md bg-card/60 backdrop-blur-xl border border-white/10 p-8 rounded-3xl shadow-2xl relative z-10 animate-fade-in">
                    <div className="text-center mb-8">
                        <div className="w-16 h-16 bg-gradient-to-tr from-blue-600 to-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-500/30">
                            <Lock className="text-white w-8 h-8" />
                        </div>
                        <h1 className="text-3xl font-bold mb-2 tracking-tight">{t.loginTitle}</h1>
                        <p className="text-muted-foreground">{t.loginDesc}</p>
                    </div>
                    <form onSubmit={handleLogin} className="space-y-5">
                        <div className="space-y-1.5">
                            <label className="text-xs font-bold uppercase text-muted-foreground ml-1">{t.username}</label>
                            <div className="relative group">
                                <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-primary transition-colors" size={18} />
                                <input name="username" className="w-full bg-muted/50 border border-border focus:border-primary/50 focus:ring-4 focus:ring-primary/10 rounded-xl py-3 pl-10 pr-4 outline-none transition-all" placeholder="Enter your username" required />
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-xs font-bold uppercase text-muted-foreground ml-1">{t.password}</label>
                            <div className="relative group">
                                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-primary transition-colors" size={18} />
                                <input name="password" type={showPassword ? "text" : "password"} className="w-full bg-muted/50 border border-border focus:border-primary/50 focus:ring-4 focus:ring-primary/10 rounded-xl py-3 pl-10 pr-12 outline-none transition-all" placeholder="••••••••" required />
                                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted transition-colors">
                                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                                </button>
                            </div>
                        </div>
                        {loginError && <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-sm font-medium text-center animate-pulse">{loginError}</div>}
                        <button disabled={isLoggingIn} className="w-full py-3.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold rounded-xl shadow-lg shadow-blue-500/25 transition-all hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed">
                            {isLoggingIn ? "Authenticating..." : <><LogIn size={20} /> {t.loginBtn}</>}
                        </button>
                    </form>
                    <div className="mt-8 pt-6 border-t border-border flex justify-between items-center">
                        <div className="flex gap-2">
                            {['en', 'vi', 'zh'].map(lang => (
                                <button key={lang} onClick={() => handleSetLanguage(lang as Language)} className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold transition-all ${language === lang ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'}`}>{lang.toUpperCase()}</button>
                            ))}
                        </div>
                        <button onClick={toggleTheme} className="p-2 rounded-lg bg-muted text-foreground hover:bg-muted/80 transition-colors">
                            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="h-screen w-full flex flex-col">
            {user?.role === 'employee' ? (
                <UserView
                    documents={documents}
                    folders={folders}
                    messages={messages}
                    isLoading={isLoading}
                    input={input}
                    onInputChange={setInput}
                    onSubmit={handleChatSubmit}
                    hasContext={documents.length > 0}
                    language={language}
                    setLanguage={handleSetLanguage}
                    onClearChat={() => setMessages([])}
                    onViewDocument={(name) => {
                        const doc = documents.find(d => d.name === name);
                        if (doc) handleOpenEditDoc(doc);
                    }}
                    sessions={sessions}
                    currentSessionId={currentSessionId}
                    onNewChat={() => { setMessages([]); setCurrentSessionId(null); }}
                    onSelectSession={(s) => { setMessages(s.messages); setCurrentSessionId(s.id); }}
                    onDeleteSession={(id) => setSessions(prev => prev.filter(s => s.id !== id))}
                    theme={theme}
                    toggleTheme={toggleTheme}
                    onLogout={handleLogout}
                    currentUser={user}
                />
            ) : (
                <AdminView
                    documents={documents}
                    folders={folders}
                    onCreateFolder={async (name, parentId) => {
                        await fetch('/api/app?handler=folders', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ action: 'create', id: Math.random().toString(36).substr(2, 9), name, parentId })
                        });
                        fetchFolders();
                    }}
                    onRenameFolder={async (id, newName) => {
                        await fetch('/api/app?handler=folders', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ action: 'update', id, name: newName })
                        });
                        fetchFolders();
                    }}
                    onDeleteFolder={async (id) => {
                        if (!window.confirm("Bạn có chắc chắn muốn xóa thư mục này?")) return;
                        await fetch('/api/app?handler=folders', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ action: 'delete', id })
                        });
                        fetchFolders();
                    }}
                    isUploading={isUploading}
                    onUpload={handleUpload}
                    onClearDocs={() => { }}
                    onEditDoc={handleOpenEditDoc}
                    onDeleteDoc={async (id) => {
                        await fetch('/api/app?handler=files', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
                        fetchDocs();
                    }}
                    language={language}
                    setLanguage={handleSetLanguage}
                    messages={messages}
                    isLoading={isLoading}
                    input={input}
                    onInputChange={setInput}
                    onSubmit={handleChatSubmit}
                    currentUserRole={user?.role || 'employee'}
                    currentUsername={user?.username || ''}
                    sessions={sessions}
                    currentSessionId={currentSessionId}
                    onNewChat={() => { setMessages([]); setCurrentSessionId(null); }}
                    onSelectSession={(s) => { setMessages(s.messages); setCurrentSessionId(s.id); }}
                    onDeleteSession={(id) => setSessions(prev => prev.filter(s => s.id !== id))}
                    config={config}
                    setConfig={handleSetConfig}
                    theme={theme}
                    toggleTheme={toggleTheme}
                    onLogout={handleLogout}
                />
            )}

            <EditDocumentDialog
                document={editingDoc ? (documents.find(d => d.id === editingDoc.id) ?? editingDoc) : null}
                isOpen={!!editingDoc}
                onClose={() => setEditingDoc(null)}
                onSave={async (id, content) => {
                    await fetch('/api/app?handler=files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, extractedContent: content }) });
                    fetchDocs();
                }}
                language={language}
            />

            {showUploadResultModal && uploadResults.length > 0 && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setShowUploadResultModal(false)}>
                    <div className="bg-card border border-border rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="p-4 border-b border-border flex justify-between items-center">
                            <h3 className="font-bold text-lg">Kết quả tải lên</h3>
                            <button type="button" className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground" onClick={() => setShowUploadResultModal(false)}>×</button>
                        </div>
                        <div className="p-4 overflow-auto flex-1">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border text-left">
                                        <th className="py-2 pr-2 font-medium">Tên file</th>
                                        <th className="py-2 pr-2 font-medium w-24">Trạng thái</th>
                                        <th className="py-2 font-medium">Chi tiết</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {uploadResults.map((r, i) => (
                                        <tr key={i} className="border-b border-border/50">
                                            <td className="py-2 pr-2 truncate max-w-[200px]" title={r.fileName}>{r.fileName}</td>
                                            <td className="py-2 pr-2"><span className={r.success ? 'text-green-600' : 'text-red-600'}>{r.success ? 'Thành công' : 'Lỗi'}</span></td>
                                            <td className="py-2 text-muted-foreground break-words">{r.error ?? '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default App;
