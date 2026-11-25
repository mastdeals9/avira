import { useEffect, useState } from 'react';
import { Bell, X, CheckCheck, AlertTriangle, Clock, Package, FileText, CheckSquare, MessageSquare, AtSign, DollarSign } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { showToast } from './ToastNotification';
import { formatDate } from '../utils/dateFormat';
import { useSupabaseRealtimeChannel } from '../hooks/useSupabaseRealtimeChannel';

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  reference_id: string | null;
  reference_type: string | null;
  is_read: boolean;
  created_at: string;
}

// Persists across sessions in localStorage — stores notification IDs that have
// already triggered a toast so they never toast again, even after re-login.
function getToastedIds(userId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`toasted_notif_${userId}`);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function addToastedIds(userId: string, ids: string[]) {
  if (!ids.length) return;
  try {
    const existing = getToastedIds(userId);
    ids.forEach(id => existing.add(id));
    // Keep max 500 IDs to avoid unbounded localStorage growth
    const trimmed = [...existing].slice(-500);
    localStorage.setItem(`toasted_notif_${userId}`, JSON.stringify(trimmed));
  } catch {
    // localStorage unavailable — silently ignore
  }
}

function displayNotificationText(notification: Notification): { title: string; message: string } {
  if (!notification.type.toLowerCase().includes('faktur')
    && !notification.title.toLowerCase().includes('faktur pajak missing')
    && !notification.message.toLowerCase().includes('faktur pajak missing')) {
    return { title: notification.title, message: notification.message };
  }
  return {
    title: 'Waiting for Faktur',
    message: notification.message.replace(/Faktur Pajak missing/gi, 'Waiting for Faktur'),
  };
}

export function NotificationDropdown() {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [pendingApprovalsCount, setPendingApprovalsCount] = useState(0);
  const { user } = useAuth();

  useEffect(() => {
    const onCountChange = (e: Event) => {
      const custom = e as CustomEvent<{ count: number }>;
      setPendingApprovalsCount(custom.detail?.count || 0);
    };
    window.addEventListener('pending-approvals-count-changed', onCountChange);
    return () => {
      window.removeEventListener('pending-approvals-count-changed', onCountChange);
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    loadNotifications();

    // Refresh when the daily notification check completes
    const onChecked = () => {
      loadNotifications();
    };
    window.addEventListener('notifications-checked', onChecked);

    return () => {
      window.removeEventListener('notifications-checked', onChecked);
    };
  }, [user]);

  useSupabaseRealtimeChannel({
    channelName: `notif_dropdown_${user?.id ?? 'anon'}`,
    table: 'notifications',
    filter: user?.id ? `user_id=eq.${user.id}` : '',
    enabled: !!user,
    onEvent: () => { loadNotifications(); },
  });

  const loadNotifications = async () => {
    try {
      const { data, error } = await supabase
        .from('notifications')
        .select('id,type,title,message,reference_id,reference_type,is_read,created_at')
        .eq('user_id', user?.id)
        .eq('is_read', false)
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) throw error;

      const newNotifications = data || [];
      setNotifications(newNotifications);
      setUnreadCount(newNotifications.length);

      // Show toasts only for IDs that have never been toasted before (persists across logins)
      const toasted = getToastedIds(user!.id);
      const newIds: string[] = [];
      newNotifications.forEach(notif => {
        if (toasted.has(notif.id)) return;
        newIds.push(notif.id);
        const display = displayNotificationText(notif);
        if (notif.type === 'appointment') {
          showToast({ type: 'appointment', title: display.title, message: display.message, duration: 8000 });
        } else {
          showToast({ type: 'info', title: display.title, message: display.message, duration: 6000 });
        }
      });
      addToastedIds(user!.id, newIds);
    } catch (error) {
      console.error('Error loading notifications:', error);
    }
  };

  const markAsRead = async (notificationId: string) => {
    try {
      const { error } = await supabase
        .from('notifications')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq('id', notificationId);

      if (error) throw error;
      addToastedIds(user!.id, [notificationId]);
      setNotifications(prev => prev.filter(n => n.id !== notificationId));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch (error) {
      console.error('Error marking notification as read:', error);
    }
  };

  const markAllAsRead = async () => {
    try {
      const now = new Date().toISOString();
      const currentIds = notifications.map(n => n.id);

      const { error } = await supabase
        .from('notifications')
        .update({ is_read: true, read_at: now })
        .eq('user_id', user?.id)
        .eq('is_read', false);

      if (error) throw error;

      // Persist all current IDs so they never toast again
      addToastedIds(user!.id, currentIds);
      setNotifications([]);
      setUnreadCount(0);
    } catch (error) {
      console.error('Error marking all as read:', error);
    }
  };

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case 'appointment':
        return <Clock className="w-5 h-5 text-blue-600" />;
      case 'low_stock':
        return <AlertTriangle className="w-5 h-5 text-orange-600" />;
      case 'near_expiry':
        return <Clock className="w-5 h-5 text-red-600" />;
      case 'pending_invoice':
        return <FileText className="w-5 h-5 text-blue-600" />;
      case 'follow_up':
        return <Bell className="w-5 h-5 text-purple-600" />;
      case 'task_assigned':
        return <CheckSquare className="w-5 h-5 text-blue-600" />;
      case 'task_mention':
        return <AtSign className="w-5 h-5 text-purple-600" />;
      case 'task_comment':
        return <MessageSquare className="w-5 h-5 text-green-600" />;
      case 'task_status_change':
        return <CheckSquare className="w-5 h-5 text-orange-600" />;
      case 'task_deadline':
        return <Clock className="w-5 h-5 text-red-600" />;
      case 'pricing':
        return <DollarSign className="w-5 h-5 text-green-600" />;
      default:
        return <Package className="w-5 h-5 text-gray-600" />;
    }
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return formatDate(date);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 rounded hover:bg-gray-100 relative"
      >
        <Bell className="w-5 h-5 text-gray-600" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 w-5 h-5 bg-red-500 rounded-full text-white text-xs flex items-center justify-center font-semibold">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute right-0 mt-2 w-96 bg-white rounded-lg shadow-xl border border-gray-200 z-40">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-lg font-semibold text-gray-900">Notifications</h3>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    onClick={markAllAsRead}
                    className="text-sm text-blue-600 hover:text-blue-700 flex items-center gap-1"
                  >
                    <CheckCheck className="w-4 h-4" />
                    Mark all read
                  </button>
                )}
                <button
                  onClick={() => setIsOpen(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {pendingApprovalsCount > 0 && (
              <div
                role="button"
                tabIndex={0}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('open-pending-approvals'));
                  setIsOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    window.dispatchEvent(new CustomEvent('open-pending-approvals'));
                    setIsOpen(false);
                  }
                }}
                className="bg-gradient-to-r from-blue-50 to-indigo-50 hover:from-blue-100 hover:to-indigo-100 border-b border-blue-200/80 px-4 py-2.5 flex items-center justify-between cursor-pointer transition select-none"
                title="Open Pending Approvals panel"
              >
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-blue-600 rounded-full animate-pulse" />
                  <span className="text-xs font-semibold text-blue-900">
                    Pending Approvals ({pendingApprovalsCount})
                  </span>
                </div>
                <span className="text-xs font-semibold text-blue-600 hover:text-blue-800 flex items-center gap-1">
                  View &rarr;
                </span>
              </div>
            )}

            <div className="max-h-96 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="p-8 text-center text-gray-500">
                  <Bell className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                  <p>No notifications</p>
                </div>
              ) : (
                notifications.map((notification) => {
                  const display = displayNotificationText(notification);
                  return (<div
                    key={notification.id}
                    className={`p-4 border-b hover:bg-gray-50 cursor-pointer transition ${
                      !notification.is_read ? 'bg-blue-50' : ''
                    }`}
                    onClick={() => {
                      if (!notification.is_read) {
                        markAsRead(notification.id);
                      }
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 mt-1">
                        {getNotificationIcon(notification.type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <p className={`text-sm font-medium ${
                            !notification.is_read ? 'text-gray-900' : 'text-gray-700'
                          }`}>
                            {display.title}
                          </p>
                          {!notification.is_read && (
                            <span className="w-2 h-2 bg-blue-600 rounded-full flex-shrink-0 mt-1.5" />
                          )}
                        </div>
                        <p className="text-sm text-gray-600 mt-1">
                          {display.message}
                        </p>
                        <p className="text-xs text-gray-400 mt-2">
                          {formatTime(notification.created_at)}
                        </p>
                      </div>
                    </div>
                  </div>
                  );
                })
              )}
            </div>

            {notifications.length > 0 && (
              <div className="p-3 border-t bg-gray-50 text-center">
                <p className="text-xs text-gray-500">
                  Showing last {notifications.length} notifications
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
