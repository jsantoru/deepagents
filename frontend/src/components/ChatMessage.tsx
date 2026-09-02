import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-ink-800 px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap">
        {content}
      </div>
    </div>
  )
}

export function AssistantMessage({ content }: { content: string }) {
  return (
    <div className="prose-cortex">
      <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
    </div>
  )
}
