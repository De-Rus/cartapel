import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from './api/client'
import { BASE } from './lib/base'
import { ToastProvider } from './components/Toast'
import Shell from './components/Shell'
import { useMeta } from './lib/meta'
import AccessRoles from './pages/AccessRoles'
import AccessUsers from './pages/AccessUsers'
import Audit from './pages/Audit'
import ConfigGroups from './pages/ConfigGroups'
import Dashboard from './pages/Dashboard'
import DashboardConfig from './pages/DashboardConfig'
import DiscoverTables from './pages/DiscoverTables'
import Login from './pages/Login'
import RowCreate from './pages/RowCreate'
import RowDetail from './pages/RowDetail'
import SlugRoute from './pages/SlugRoute'
import TableList from './pages/TableList'

function AccessGate({ children }: { children: React.ReactNode }) {
  const meta = useMeta()
  if (!meta.can_manage_access) return <Navigate to="/" replace />
  return <>{children}</>
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter basename={BASE || '/'}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<Shell />}>
              <Route index element={<Dashboard />} />
              <Route path="audit" element={<Audit />} />
              <Route path="_access/users" element={<AccessGate><AccessUsers /></AccessGate>} />
              <Route path="_access/roles" element={<AccessGate><AccessRoles /></AccessGate>} />
              <Route path="_config/groups" element={<AccessGate><ConfigGroups /></AccessGate>} />
              <Route path="_config/dashboard" element={<AccessGate><DashboardConfig /></AccessGate>} />
              <Route path="_config/discover" element={<AccessGate><DiscoverTables /></AccessGate>} />
              <Route path="p/*" element={<SlugRoute />} />
              <Route path=":table" element={<TableList />} />
              <Route path=":table/new" element={<RowCreate />} />
              <Route path=":table/:pk" element={<RowDetail />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  )
}
