
import React, { useRef, useEffect, useState } from 'react';
import { Message, Role, ChatSession, Language, Document } from '../types';
import { Send, Bot, User, Cpu, FileText, ExternalLink, Plus, MessageSquare, Trash2, Menu, X, Download, File, ArrowUpRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { TRANSLATIONS } from '../constants';

interface ChatInterfaceProps {
  messages: Message[];
  isLoading: boolean;
  input: string;
  onInputChange: (val: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  hasContext: boolean;
  documents?: Document[];
  onViewDocument?: (filename: string) => void;
  sessions: ChatSession[];
  currentSessionId: string | null;
  onNewChat: () => void;
  onSelectSession: (session: ChatSession) => void;
  onDeleteSession: (sessionId: string) => void;
  language?: Language;
}

const ChatInterface: React.FC<ChatInterfaceProps> = ({
  messages, isLoading, input, onInputChange, onSubmit, hasContext, documents = [], onViewDocument,
  sessions, currentSessionId, onNewChat, onSelectSession, onDeleteSession, language = 'vi'
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const t = (TRANSLATIONS as any)[language] || TRANSLATIONS.en;

  const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  useEffect(() => { scrollToBottom(); }, [messages]);

  const handleDownloadFile = (filename: string) => {
    const doc = documents.find(d => d.name === filename);
    if (!doc || doc.size === 0) return;
    try {
      if (doc.content.startsWith('data:')) {
        const link = window.document.createElement('a');
        link.href = doc.content;
        link.download = doc.name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } else {
        const a = document.createElement('a');
        a.href = doc.content;
        a.target = '_blank';
        a.download = doc.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch (e) { console.error(e); }
  };

  const findDocByRef = (ref: string): Document | undefined => {
    const trimmed = ref.trim();
    const exact = documents.find(d => d.name === trimmed);
    if (exact) return exact;
    return documents.find(d => d.name.startsWith(trimmed) || trimmed.endsWith(d.name) || d.name.includes(trimmed));
  };

  const FILE_REF_PREFIX = '#view-doc:';
  const contentWithFileLinks = (raw: string) =>
    raw.replace(/\[\[File:\s*([^\]]*?)\]\]/g, (_, name) => `[📎 ${name.trim()}](${FILE_REF_PREFIX}${encodeURIComponent(name.trim())})`);

  const renderContent = (content: string) => {
    const fileRegex = /\[\[File:\s*([^\]]*?)\]\]/g;
    const uniqueFileRefs = Array.from(new Set(Array.from(content.matchAll(fileRegex)).map(m => m[1].trim())));

    return (
      <div className="space-y-4">
        <div className="prose prose-sm dark:prose-invert max-w-none break-words">
          <ReactMarkdown
            components={{
              a: ({ href, children }) => {
                if (href?.startsWith(FILE_REF_PREFIX)) {
                  const name = decodeURIComponent(href.slice(FILE_REF_PREFIX.length));
                  const doc = findDocByRef(name);
                  return (
                    <span className="inline-flex items-center gap-1 align-middle mx-0.5">
                      <span className="px-1.5 py-0.5 rounded bg-primary/15 text-primary text-xs font-medium border border-primary/30">
                        📎 {children}
                      </span>
                      {doc && (
                        <>
                          <button type="button" onClick={() => onViewDocument?.(doc.name)} className="text-xs text-primary hover:underline" title="Mở tài liệu">Mở</button>
                          <button type="button" onClick={() => handleDownloadFile(doc.name)} className="text-muted-foreground hover:text-foreground p-0.5" title="Tải xuống tài liệu"><Download size={12} /></button>
                        </>
                      )}
                    </span>
                  );
                }
                return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
              }
            }}
          >
            {contentWithFileLinks(content)}
          </ReactMarkdown>
        </div>
        {uniqueFileRefs.length > 0 && (
          <div className="flex flex-col gap-3 mt-2">
            <p className="text-xs font-medium text-muted-foreground">Tài liệu tham chiếu</p>
            {uniqueFileRefs.map((ref, idx) => {
              const doc = findDocByRef(ref);
              if (!doc || doc.size === 0) return null;
              const sizeMB = (doc.size / (1024 * 1024)).toFixed(2);
              return (
                <div key={idx} className="flex items-center gap-4 p-3 rounded-xl border border-border bg-card hover:bg-muted/50 transition-all group shadow-sm max-w-md">
                  <div className="w-10 h-10 rounded-lg bg-blue-500/10 text-blue-600 flex items-center justify-center shrink-0">
                    <FileText size={20} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm truncate text-foreground">{doc.name}</div>
                    <div className="text-xs text-muted-foreground flex gap-2">
                      <span>{sizeMB} MB</span>
                      <span>• Xem / Tải xuống</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => onViewDocument?.(doc.name)}
                      className="p-2 rounded-lg bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground transition-all font-bold text-xs flex items-center gap-1"
                    >
                      <ArrowUpRight size={14} /> Mở
                    </button>
                    <button
                      onClick={() => handleDownloadFile(doc.name)}
                      className="p-2 rounded-lg text-muted-foreground hover:bg-muted transition-colors"
                      title="Tải xuống"
                    >
                      <Download size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full w-full bg-transparent overflow-hidden relative">
      <div className={`
          absolute md:relative z-20 h-full w-80 bg-card/40 backdrop-blur-3xl border-r border-white/5 flex flex-col transition-transform duration-500 cubic-bezier(0.4, 0, 0.2, 1)
          ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        <div className="p-6 border-b border-white/5">
          <button
            onClick={() => { onNewChat(); setIsSidebarOpen(false); }}
            className="w-full flex items-center justify-center gap-3 bg-primary text-white hover:bg-primary/90 px-6 py-4 rounded-2xl transition-all font-black text-[10px] uppercase tracking-widest shadow-lg shadow-primary/20 hover:scale-105 active:scale-95"
          >
            <Plus size={18} /> <span>{t.newChat}</span>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
          <div className="px-4 py-2 text-[10px] font-black text-muted-foreground uppercase tracking-[0.2em] opacity-40">Cognitive History</div>
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`group flex items-center justify-between p-4 rounded-2xl cursor-pointer transition-all border ${currentSessionId === session.id
                ? 'bg-primary/10 border-primary/20 text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-white/5 hover:text-foreground'
                }`}
              onClick={() => { onSelectSession(session); setIsSidebarOpen(false); }}
            >
              <div className="flex items-center gap-4 truncate flex-1">
                <MessageSquare size={16} className={currentSessionId === session.id ? "text-primary" : "opacity-30"} />
                <span className="truncate font-black text-[11px] uppercase tracking-tight">{session.title || "Observation Matrix"}</span>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteSession(session.id); }}
                className="p-2 rounded-xl opacity-0 group-hover:opacity-100 hover:bg-red-500/10 hover:text-red-500 transition-all"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 flex flex-col h-full relative w-full bg-transparent">
        <div className="md:hidden absolute top-4 left-4 z-30">
          <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-3 bg-card/60 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl">
            {isSidebarOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 md:p-12 space-y-10 scroll-smooth custom-scrollbar relative">
          <div className="absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent pointer-events-none" />
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-8 animate-fade-in relative z-10">
              <div className="w-28 h-28 bg-gradient-to-tr from-primary/20 to-indigo-500/20 rounded-[2.5rem] flex items-center justify-center mb-10 ring-1 ring-white/10 shadow-[0_30px_60px_rgba(99,102,241,0.2)] animate-float">
                <Cpu className="w-14 h-14 text-primary" />
              </div>
              <h3 className="text-4xl font-black mb-4 tracking-tighter uppercase">{hasContext ? "Matrix Knowledge Link" : "System Offline"}</h3>
              <p className="max-w-md text-muted-foreground font-black text-xs uppercase tracking-widest opacity-60 leading-relax mb-10">
                {hasContext ? t.userDesc : "Synchronize archives to begin cognitive extraction."}
              </p>

              {hasContext && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-lg w-full">
                  <button onClick={() => onInputChange("Nội quy công ty")} className="glass-panel hover:bg-primary/10 border-white/5 p-6 rounded-2xl text-[10px] font-black uppercase tracking-widest text-left transition-all hover:scale-105 active:scale-95 flex items-center gap-3">
                    <span className="text-2xl">📜</span> Nội quy công ty
                  </button>
                  <button onClick={() => onInputChange("Mẫu đơn xin nghỉ phép")} className="glass-panel hover:bg-indigo-500/10 border-white/5 p-6 rounded-2xl text-[10px] font-black uppercase tracking-widest text-left transition-all hover:scale-105 active:scale-95 flex items-center gap-3">
                    <span className="text-2xl">📝</span> Đơn xin nghỉ
                  </button>
                </div>
              )}
            </div>
          ) : (
            messages.map((msg) => (
              <div key={msg.id} className={`flex w-full animate-slide-up ${msg.role === Role.USER ? 'justify-end' : 'justify-start'} relative z-10`}>
                <div className={`flex max-w-[95%] lg:max-w-[85%] gap-6 ${msg.role === Role.USER ? 'flex-row-reverse' : 'flex-row'}`}>
                  <div className={`w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0 shadow-2xl shrink-0 ${msg.role === Role.USER ? 'bg-primary text-white' : 'bg-card border border-white/10 text-primary'
                    }`}>
                    {msg.role === Role.USER ? <User size={24} /> : <Bot size={24} className="animate-float" />}
                  </div>
                  <div className={`p-8 rounded-[2rem] shadow-2xl border ${msg.role === Role.USER
                    ? 'bg-primary/90 text-white border-primary rounded-tr-none'
                    : 'glass-panel border-white/10 rounded-tl-none'
                    }`}>
                    <div className="text-sm font-black leading-relaxed tracking-tight">
                      {renderContent(msg.content)}
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}

          {isLoading && (
            <div className="flex justify-start w-full relative z-10">
              <div className="flex max-w-[80%] gap-6">
                <div className="w-12 h-12 rounded-2xl bg-card border border-white/10 flex items-center justify-center text-primary shadow-2xl">
                  <Bot size={24} className="animate-float" />
                </div>
                <div className="glass-panel border-white/10 p-6 rounded-[2rem] rounded-tl-none shadow-2xl flex items-center gap-3 h-16">
                  <span className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} className="h-20" />
        </div>

        <div className="p-6 md:p-12 bg-transparent relative z-20">
          <form onSubmit={onSubmit} className="max-w-4xl mx-auto relative group">
            <div className="absolute inset-0 bg-primary/20 blur-3xl opacity-0 group-focus-within:opacity-100 transition-opacity" />
            <input
              type="text"
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              placeholder={hasContext ? "Request Archive Deep Scan..." : "System Initialization..."}
              disabled={isLoading}
              className="w-full glass-panel border-white/10 rounded-[2.5rem] px-10 py-6 pr-20 text-base font-black tracking-tight focus:outline-none focus:ring-8 focus:ring-primary/5 transition-all shadow-2xl relative z-10 placeholder:text-muted-foreground/30 placeholder:uppercase placeholder:text-[10px] placeholder:tracking-[0.3em]"
            />
            <button
              type="submit"
              disabled={!input.trim() || isLoading}
              className="absolute right-4 top-1/2 -translate-y-1/2 w-14 h-14 bg-primary text-white rounded-[1.5rem] hover:scale-110 active:scale-95 disabled:opacity-30 disabled:scale-100 disabled:cursor-not-allowed transition-all shadow-xl shadow-primary/30 z-20 flex items-center justify-center"
            >
              <Send size={24} />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default ChatInterface;
