
import React, { useState, useEffect } from 'react';
import { User, UserRole } from '../types';
import { X, UserPlus, Trash2, Shield, Users, Briefcase, Search, Filter, Monitor } from 'lucide-react';
import { TRANSLATIONS } from '../constants';

interface UserManagementDialogProps {
  isOpen: boolean; 
  onClose?: () => void; 
  currentUserRole: UserRole;
  currentUsername: string;
  isInline?: boolean; 
}

const UserManagementDialog: React.FC<UserManagementDialogProps> = ({ 
  isOpen, 
  onClose, 
  currentUserRole, 
  currentUsername, 
  isInline = false 
}) => {
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'employee' as UserRole });
  const [error, setError] = useState('');
  
  // New State for Filter
  const [filterRole, setFilterRole] = useState<UserRole | 'all'>('all');

  const language = (localStorage.getItem('app-language') || 'vi') as any;
  const t = TRANSLATIONS[language] || TRANSLATIONS.en;

  const fetchUsers = async () => {
    setIsLoading(true);
    try {
        const res = await fetch('/api/app?handler=users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'list' })
        });
        const data = await res.json();
        if (data.users) setUsers(data.users);
    } catch (e) {
        console.error(e);
    } finally {
        setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen || isInline) fetchUsers();
  }, [isOpen, isInline]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUser.username || !newUser.password) {
        setError("Vui lòng điền đủ thông tin.");
        return;
    }
    
    setError('');
    try {
        const res = await fetch('/api/app?handler=users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                action: 'create',
                username: newUser.username,
                password: newUser.password,
                role: newUser.role,
                creatorRole: currentUserRole,
                createdBy: currentUsername
            })
        });
        const data = await res.json();
        if (data.success) {
            alert("Tạo tài khoản thành công!");
            setNewUser({ username: '', password: '', role: 'employee' as UserRole });
            fetchUsers();
        } else {
            setError(data.error || "Tạo thất bại.");
        }
    } catch (e: any) {
        setError(e.message);
    }
  };

  const handleDeleteUser = async (username: string) => {
    if (!confirm(`Xóa tài khoản ${username}?`)) return;
    try {
        await fetch('/api/app?handler=users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete', username })
        });
        fetchUsers();
    } catch (e) {
        alert("Lỗi khi xóa.");
    }
  };

  // Filter Logic
  const filteredUsers = users.filter(u => filterRole === 'all' || u.role === filterRole);

  const getRoleCount = (r: UserRole | 'all') => {
      if (r === 'all') return users.length;
      return users.filter(u => u.role === r).length;
  };

  if (!isOpen && !isInline) return null;

  const inputClass = "w-full bg-background border border-border text-foreground rounded-xl px-4 py-3 text-sm mt-1 focus:ring-2 focus:ring-primary/50 outline-none placeholder:text-muted-foreground transition-all";

  const renderContent = () => (
    <div className={`flex flex-col md:flex-row h-full ${isInline ? 'gap-0' : ''}`}>
        {/* Form Tạo User */}
        <div className={`w-full md:w-[320px] ${isInline ? 'border-r border-border' : 'border-r border-border'} p-6 bg-muted/10`}>
            <h4 className="font-bold mb-6 flex items-center gap-2 text-sm uppercase tracking-wider text-primary">
                <UserPlus size={18} /> {t.createUser || "Tạo người dùng mới"}
            </h4>
            <form onSubmit={handleCreateUser} className="space-y-5">
                <div>
                    <label className="text-xs font-bold text-muted-foreground uppercase">{t.username}</label>
                    <input 
                        type="text" 
                        value={newUser.username}
                        onChange={e => setNewUser({...newUser, username: e.target.value})}
                        className={inputClass}
                        placeholder="vd: nhanvien01"
                    />
                </div>
                <div>
                    <label className="text-xs font-bold text-muted-foreground uppercase">{t.password}</label>
                    <input 
                        type="text" 
                        value={newUser.password}
                        onChange={e => setNewUser({...newUser, password: e.target.value})}
                        className={inputClass}
                        placeholder="••••••••"
                    />
                </div>
                <div>
                    <label className="text-xs font-bold text-muted-foreground uppercase">{t.role}</label>
                    <div className="relative">
                        <select 
                            value={newUser.role}
                            onChange={e => setNewUser({...newUser, role: e.target.value as UserRole})}
                            className={`${inputClass} appearance-none cursor-pointer`}
                        >
                            <option value="employee">Employee (Nhân viên)</option>
                            
                            {/* HR, IT, Superadmin đều có quyền tạo HR và IT */}
                            {(currentUserRole === 'superadmin' || currentUserRole === 'hr' || currentUserRole === 'it') && (
                                <>
                                    <option value="hr">HR Manager</option>
                                    <option value="it">IT Specialist</option>
                                </>
                            )}
                            
                            {/* Chỉ Superadmin tạo được Superadmin */}
                            {currentUserRole === 'superadmin' && (
                                <option value="superadmin">Super Admin</option>
                            )}
                        </select>
                        <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground">
                            <Briefcase size={14} />
                        </div>
                    </div>
                </div>

                {error && <div className="text-red-500 text-xs bg-red-500/10 p-2 rounded-lg border border-red-500/20">{error}</div>}
                
                <button type="submit" className="w-full py-3 bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl font-bold text-sm transition-all shadow-lg shadow-primary/25 mt-2 flex items-center justify-center gap-2">
                    <UserPlus size={16} /> {t.create}
                </button>
            </form>
        </div>

        {/* Danh sách User */}
        <div className={`flex-1 p-6 flex flex-col overflow-hidden`}>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                <h4 className="font-bold flex items-center gap-2 text-sm uppercase tracking-wider text-foreground">
                    <Users size={18} /> {t.userList} 
                </h4>
                
                {/* Role Filter Tabs */}
                <div className="flex p-1 bg-muted rounded-lg self-start sm:self-auto overflow-x-auto">
                    {(['all', 'superadmin', 'it', 'hr', 'employee'] as const).map((r) => (
                        <button
                            key={r}
                            onClick={() => setFilterRole(r)}
                            className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all flex items-center gap-2 shrink-0 ${
                                filterRole === r 
                                ? 'bg-background text-foreground shadow-sm' 
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                        >
                            <span className="capitalize">{r === 'all' ? 'All' : (r === 'superadmin' ? 'Root' : r.toUpperCase())}</span>
                            <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${filterRole === r ? 'bg-muted' : 'bg-background'}`}>
                                {getRoleCount(r)}
                            </span>
                        </button>
                    ))}
                </div>
            </div>
            
            <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                {isLoading ? (
                    <div className="text-muted-foreground text-sm flex items-center gap-2"><div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin"></div> Loading...</div>
                ) : (
                    <div className="space-y-3">
                        {filteredUsers.length === 0 && (
                            <div className="text-muted-foreground text-sm italic p-8 text-center border border-dashed border-border rounded-xl">
                                Không tìm thấy người dùng phù hợp.
                            </div>
                        )}
                        {filteredUsers.map((u) => (
                            <div key={u.username} className="group flex items-center justify-between p-3 border border-border rounded-xl bg-background hover:border-primary/50 transition-all shadow-sm">
                                <div className="flex items-center gap-4">
                                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shadow-inner ${
                                        u.role === 'superadmin' ? 'bg-red-500/10 text-red-500' :
                                        u.role === 'it' ? 'bg-purple-500/10 text-purple-500' :
                                        u.role === 'hr' ? 'bg-blue-500/10 text-blue-500' : 'bg-green-500/10 text-green-500'
                                    }`}>
                                        {u.role === 'superadmin' ? <Shield size={16}/> : 
                                         u.role === 'it' ? <Monitor size={16} /> :
                                         u.role === 'hr' ? <Briefcase size={16}/> : <Users size={16}/>}
                                    </div>
                                    <div>
                                        <div className="font-bold text-sm text-foreground">{u.username}</div>
                                        <div className="text-xs text-muted-foreground flex gap-2 items-center mt-0.5">
                                            <span className="uppercase font-bold text-[10px] tracking-wider">
                                                {u.role === 'superadmin' ? 'ROOT' : u.role}
                                            </span>
                                            <span className="w-0.5 h-0.5 rounded-full bg-foreground/50"></span>
                                            <span>By: {u.createdBy || 'System'}</span>
                                        </div>
                                    </div>
                                </div>
                                <button 
                                    onClick={() => handleDeleteUser(u.username)}
                                    className="p-2 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                                    title="Xóa người dùng"
                                >
                                    <Trash2 size={16} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    </div>
  );

  if (isInline) {
      return renderContent();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-card w-full max-w-5xl h-[85vh] rounded-2xl border border-border flex flex-col shadow-2xl overflow-hidden">
        <div className="p-4 border-b border-border flex items-center justify-between bg-muted/20">
            <h3 className="font-bold text-lg flex items-center gap-2 text-foreground">
                <Users className="text-primary" /> {t.userList}
            </h3>
            <button onClick={onClose} className="p-2 hover:bg-muted rounded-full text-foreground"><X size={20}/></button>
        </div>
        <div className="flex-1 overflow-hidden">
            {renderContent()}
        </div>
      </div>
    </div>
  );
};

export default UserManagementDialog;
