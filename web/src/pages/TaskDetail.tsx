import { useParams } from 'react-router-dom'
import { TaskView } from '../components/TaskView'

/** Trang toàn màn hình /tasks/:id (link chia sẻ, thông báo). Nội dung dùng chung với khung chi tiết. */
export function TaskDetail() {
  const { id } = useParams()
  return <TaskView key={id} taskId={Number(id)} mode="page" />
}
