import { HashRouter, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Board } from './pages/Board'
import { Inbox } from './pages/Inbox'
import { TaskDetail } from './pages/TaskDetail'
import { Projects } from './pages/Projects'
import { Settings } from './pages/Settings'
import { Stats } from './pages/Stats'

export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Board />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}
