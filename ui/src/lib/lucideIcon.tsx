import { DynamicIcon, dynamicIconImports, type IconName } from 'lucide-react/dynamic'

export default function LucideIcon({
  name,
  size,
  className,
}: {
  name: string
  size: number
  className?: string
}) {
  if (!(name in dynamicIconImports)) {
    return (
      <span className={className} aria-hidden>
        {name}
      </span>
    )
  }
  return (
    <DynamicIcon
      name={name as IconName}
      size={size}
      className={className}
      aria-hidden
      fallback={() => (
        <span
          className={className}
          style={{ display: 'inline-block', width: size, height: size }}
          aria-hidden
        />
      )}
    />
  )
}
