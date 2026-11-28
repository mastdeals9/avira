import { lazy, Suspense } from 'react';
import { BrowserRouter, useLocation, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { LanguageProvider } from './contexts/LanguageContext';
import { NavigationProvider, useNavigation } from './contexts/NavigationContext';
import { FinanceProvider } from './contexts/FinanceContext';
import { Login } from './components/Login';
import { ToastContainer } from './components/ToastNotification';
import { ConfirmDialogContainer } from './components/ConfirmDialog';

const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Products = lazy(() => import('./pages/Products').then(m => ({ default: m.Products })));
const Customers = lazy(() => import('./pages/Customers').then(m => ({ default: m.Customers })));
const Stock = lazy(() => import('./pages/Stock').then(m => ({ default: m.Stock })));
const Batches = lazy(() => import('./pages/Batches').then(m => ({ default: m.Batches })));
const Inventory = lazy(() => import('./pages/Inventory').then(m => ({ default: m.Inventory })));
const CRM = lazy(() => import('./pages/CRM').then(m => ({ default: m.CRM })));
const CRMCommandCenter = lazy(() => import('./pages/CRMCommandCenter').then(m => ({ default: m.CRMCommandCenter })));
const Tasks = lazy(() => import('./pages/Tasks').then(m => ({ default: m.Tasks })));
const DeliveryChallan = lazy(() => import('./pages/DeliveryChallan').then(m => ({ default: m.DeliveryChallan })));
const Sales = lazy(() => import('./pages/Sales').then(m => ({ default: m.Sales })));
const Finance = lazy(() => import('./pages/Finance').then(m => ({ default: m.Finance })));
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));
const GmailCallback = lazy(() => import('./pages/GmailCallback').then(m => ({ default: m.GmailCallback })));
const SalesOrders = lazy(() => import('./pages/SalesOrders'));
const ImportRequirements = lazy(() => import('./pages/ImportRequirements'));
const ImportContainers = lazy(() => import('./pages/ImportContainers'));
const MaterialReturns = lazy(() => import('./pages/MaterialReturns'));
const CreditNotes = lazy(() => import('./pages/CreditNotes').then(m => ({ default: m.CreditNotes })));
const PurchaseOrders = lazy(() => import('./pages/PurchaseOrders'));
const SalesTeam = lazy(() => import('./pages/SalesTeam').then(m => ({ default: m.SalesTeam })));
const PriceCalculator = lazy(() => import('./pages/PriceCalculator').then(m => ({ default: m.PriceCalculator })));
const PublicCalculator = lazy(() => import('./pages/PublicCalculator').then(m => ({ default: m.PublicCalculator })));
const Reports = lazy(() => import('./pages/reports/Reports').then(m => ({ default: m.Reports })));
const PriceRequests = lazy(() => import('./pages/PriceRequests').then(m => ({ default: m.PriceRequests })));
const PricingDesk = lazy(() => import('./pages/PricingDesk').then(m => ({ default: m.PricingDesk })));
const PricingLedger = lazy(() => import('./pages/PricingLedger').then(m => ({ default: m.PricingLedger })));
const PricingParserReview = lazy(() => import('./pages/PricingParserReview').then(m => ({ default: m.PricingParserReview })));
const PricingDashboard = lazy(() => import('./pages/PricingDashboard').then(m => ({ default: m.PricingDashboard })));
const PricingWorksheet = lazy(() => import('./pages/PricingWorksheet').then(m => ({ default: m.PricingWorksheet })));
const SourcingOutbox = lazy(() => import('./pages/SourcingOutbox').then(m => ({ default: m.SourcingOutbox })));
const DocumentBankPage = lazy(() => import('./pages/DocumentBankPage').then(m => ({ default: m.DocumentBankPage })));

function LoadingFallback() {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-blue-600 mx-auto" />
        <p className="mt-4 text-gray-600">Loading...</p>
      </div>
    </div>
  );
}

function AppContent() {
  const { user, profile, loading, accessibleModules } = useAuth();
  const { currentPage } = useNavigation();
  const location = useLocation();

  if (location.pathname === '/calculator') {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <PublicCalculator />
      </Suspense>
    );
  }

  if (location.pathname === '/auth/gmail/callback') {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <GmailCallback />
      </Suspense>
    );
  }

  if (loading) {
    return <LoadingFallback />;
  }

  if (!user || !profile) {
    return <Login />;
  }

  if (location.pathname === '/') {
    return <Navigate to="/dashboard" replace />;
  }

  const pricingPages = new Set(['price-requests', 'pricing-desk', 'pricing-ledger', 'pricing-parser-review', 'pricing-dashboard', 'pricing-worksheet', 'sourcing-outbox']);
  if (pricingPages.has(currentPage)) {
    const hasModuleAccess = accessibleModules.has(currentPage);
    // Internal-only pricing pages — admin/manager only. Sales must never see these.
    const internalPages = new Set(['pricing-desk', 'pricing-worksheet', 'sourcing-outbox', 'pricing-ledger', 'price-requests', 'pricing-parser-review']);
    const hasInternalRole = !internalPages.has(currentPage) || profile.role === 'admin' || profile.role === 'manager';
    if (!hasModuleAccess || !hasInternalRole) {
      return <Navigate to="/dashboard" replace />;
    }
  }

  const renderPage = () => {
    switch (currentPage) {
      case 'dashboard':
        return <Dashboard />;
      case 'products':
        return <Products />;
      case 'stock':
        return <Stock />;
      case 'batches':
        return <Batches />;
      case 'inventory':
        return <Inventory />;
      case 'customers':
        return <Customers />;
      case 'sales-orders':
        return <SalesOrders />;
      case 'purchase-orders':
        return <PurchaseOrders />;
      case 'import-requirements':
        return <ImportRequirements />;
      case 'import-containers':
        return <ImportContainers />;
      case 'crm':
        return <CRM />;
      case 'document-bank':
        return <DocumentBankPage />;
      case 'command-center':
        return <CRMCommandCenter />;
      case 'sales-team':
        return <SalesTeam />;
      case 'tasks':
        return <Tasks />;
      case 'delivery-challan':
        return <DeliveryChallan />;
      case 'sales':
        return <Sales />;
      case 'credit-notes':
        return <CreditNotes />;
      case 'material-returns':
        return <MaterialReturns />;
      case 'finance':
        return <Finance />;
      case 'price-calculator':
        return <PriceCalculator />;
      case 'reports':
        return <Reports />;
      case 'price-requests':
        return <PriceRequests />;
      case 'pricing-desk':
        return <PricingDesk />;
      case 'pricing-ledger':
        return <PricingLedger />;
      case 'pricing-parser-review':
        return <PricingParserReview />;
      case 'pricing-dashboard':
        return <PricingDashboard />;
      case 'pricing-worksheet':
        return <PricingWorksheet />;
      case 'sourcing-outbox':
        return <SourcingOutbox />;
      case 'settings':
        return <Settings />;
      default:
        return <Dashboard />;
    }
  };

  return (
    <>
      <Suspense fallback={<LoadingFallback />}>
        {renderPage()}
      </Suspense>
      <ToastContainer />
      <ConfirmDialogContainer />
    </>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <LanguageProvider>
          <NavigationProvider>
            <FinanceProvider>
              <AppContent />
            </FinanceProvider>
          </NavigationProvider>
        </LanguageProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
