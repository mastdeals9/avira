import { useEffect, useState } from 'react';
import { X, Bell, Calendar, CheckCircle, AlertCircle, Info } from 'lucide-react';

interface Toast {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error' | 'appointment';
  title: string;
  message: string;
  duration?: number;
}

interface ToastNotificationProps {
  toast: Toast;
  onClose: (id: string) => void;
}

function ToastItem({ toast, onClose }: ToastNotificationProps) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose(toast.id);
    }, toast.duration || 5000);

    return () => clearTimeout(timer);
  }, [toast, onClose]);

  const getIcon = () => {
    switch (toast.type) {
      case 'appointment':
        return <Calendar className="h-5 w-5 text-blue-600" />;
      case 'success':
        return <CheckCircle className="h-5 w-5 text-green-600" />;
      case 'warning':
        return <AlertCircle className="h-5 w-5 text-yellow-600" />;
      case 'error':
        return <AlertCircle className="h-5 w-5 text-red-600" />;
      default:
        return <Info className="h-5 w-5 text-blue-600" />;
    }
  };

  const getBgColor = () => {
    switch (toast.type) {
      case 'appointment':
        return 'bg-blue-50 border-blue-200';
      case 'success':
        return 'bg-green-50 border-green-200';
      case 'warning':
        return 'bg-yellow-50 border-yellow-200';
      case 'error':
        return 'bg-red-50 border-red-200';
      default:
        return 'bg-white border-gray-200';
    }
  };

  return (
    <div
      className={`${getBgColor()} border rounded-lg shadow-lg p-2.5 sm:p-3.5 mb-2 w-full sm:w-auto sm:min-w-72 sm:max-w-md animate-slide-in`}
      style={{
        animation: 'slideIn 0.3s ease-out'
      }}
    >
      <div className="flex items-start gap-2.5">
        <div className="flex-shrink-0 mt-0.5">
          {getIcon()}
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-xs sm:text-sm font-semibold text-gray-900 mb-0.5">
            {toast.title}
          </h4>
          <p className="text-xs sm:text-sm text-gray-700 break-words">
            {toast.message}
          </p>
        </div>
        <button
          onClick={() => onClose(toast.id)}
          className="no-compact flex-shrink-0 p-1 text-gray-400 hover:text-gray-600 transition"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const handleNewToast = (event: CustomEvent<Toast>) => {
      setToasts(prev => [...prev, event.detail]);
    };

    window.addEventListener('showToast' as any, handleNewToast);
    return () => window.removeEventListener('showToast' as any, handleNewToast);
  }, []);

  const handleClose = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  return (
    <div className="fixed top-14 right-2.5 left-2.5 sm:left-auto sm:right-4 sm:top-14 z-[9999] pointer-events-none">
      <div className="pointer-events-auto">
        {toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} onClose={handleClose} />
        ))}
      </div>
    </div>
  );
}

export function showToast(toast: Omit<Toast, 'id'>) {
  const event = new CustomEvent('showToast', {
    detail: {
      ...toast,
      id: Math.random().toString(36).substring(7)
    }
  });
  window.dispatchEvent(event);
}
