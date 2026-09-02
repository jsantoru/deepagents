import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'
import { useEffect, useRef } from 'react'

import { entityColor, type GraphEdge, type GraphNode } from '@/lib/api'

interface SimNode extends SimulationNodeDatum {
  id: string
  node: GraphNode
  radius: number
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  edge: GraphEdge
}

interface MemoryGraphCanvasProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** When set, nodes/edges outside this set render ghosted (memory time-travel). */
  visibleNodeIds?: Set<string> | null
  selectedId?: string | null
  onSelect?: (node: GraphNode | null) => void
}

export function MemoryGraphCanvas({
  nodes,
  edges,
  visibleNodeIds,
  selectedId,
  onSelect,
}: MemoryGraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null)
  const stateRef = useRef({
    simNodes: [] as SimNode[],
    simLinks: [] as SimLink[],
    transform: { x: 0, y: 0, k: 1 },
    hovered: null as SimNode | null,
    visible: null as Set<string> | null,
    selectedId: null as string | null,
    dragging: null as SimNode | null,
    panning: false,
    lastPointer: { x: 0, y: 0 },
    moved: false,
  })

  stateRef.current.visible = visibleNodeIds ?? null
  stateRef.current.selectedId = selectedId ?? null

  // (Re)build the simulation when graph data changes.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const state = stateRef.current

    const prev = new Map(state.simNodes.map((n) => [n.id, n]))
    const degree = new Map<string, number>()
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
    }

    state.simNodes = nodes.map((node) => {
      const existing = prev.get(node.id)
      const radius =
        5 + Math.min(11, Math.sqrt(node.mention_count) * 2 + (degree.get(node.id) ?? 0) * 0.6)
      return {
        id: node.id,
        node,
        radius,
        x: existing?.x ?? (Math.random() - 0.5) * 400,
        y: existing?.y ?? (Math.random() - 0.5) * 400,
        vx: existing?.vx ?? 0,
        vy: existing?.vy ?? 0,
      }
    })
    const byId = new Map(state.simNodes.map((n) => [n.id, n]))
    state.simLinks = edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((edge) => ({ source: edge.source, target: edge.target, edge }))

    simRef.current?.stop()
    simRef.current = forceSimulation<SimNode>(state.simNodes)
      .force('charge', forceManyBody().strength(-160))
      .force(
        'link',
        forceLink<SimNode, SimLink>(state.simLinks)
          .id((d) => d.id)
          .distance(70)
          .strength(0.4),
      )
      .force('center', forceCenter(0, 0))
      .force('collide', forceCollide<SimNode>().radius((d) => d.radius + 6))
      .alpha(0.9)
      .restart()

    return () => {
      simRef.current?.stop()
    }
  }, [nodes, edges])

  // Render + interaction loop.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const state = stateRef.current
    let frame = 0

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    const draw = () => {
      frame = requestAnimationFrame(draw)
      const dpr = window.devicePixelRatio || 1
      const width = canvas.width / dpr
      const height = canvas.height / dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)

      const { x, y, k } = state.transform
      ctx.save()
      ctx.translate(width / 2 + x, height / 2 + y)
      ctx.scale(k, k)

      const visible = state.visible
      const isVisible = (id: string) => visible === null || visible.has(id)

      for (const link of state.simLinks) {
        const source = link.source as SimNode
        const target = link.target as SimNode
        if (source.x == null || target.x == null) continue
        const active = isVisible(source.id) && isVisible(target.id)
        ctx.beginPath()
        ctx.moveTo(source.x, source.y!)
        ctx.lineTo(target.x!, target.y!)
        ctx.strokeStyle = active
          ? `rgba(140, 140, 152, ${Math.min(0.6, 0.18 + link.edge.weight * 0.08)})`
          : 'rgba(140, 140, 152, 0.05)'
        ctx.lineWidth = active ? Math.min(2.5, 0.6 + link.edge.weight * 0.3) / k : 0.5 / k
        ctx.stroke()
      }

      for (const simNode of state.simNodes) {
        if (simNode.x == null || simNode.y == null) continue
        const active = isVisible(simNode.id)
        const isHovered = state.hovered?.id === simNode.id
        const isSelected = state.selectedId === simNode.id
        const color = entityColor(simNode.node.type)

        ctx.beginPath()
        ctx.arc(simNode.x, simNode.y, simNode.radius, 0, Math.PI * 2)
        ctx.fillStyle = active ? color : 'rgba(60, 60, 68, 0.35)'
        ctx.globalAlpha = active ? (isHovered || isSelected ? 1 : 0.85) : 1
        ctx.fill()
        ctx.globalAlpha = 1

        if (isSelected || isHovered) {
          ctx.beginPath()
          ctx.arc(simNode.x, simNode.y, simNode.radius + 3 / k, 0, Math.PI * 2)
          ctx.strokeStyle = isSelected ? '#f4f4f6' : 'rgba(244,244,246,0.5)'
          ctx.lineWidth = 1.5 / k
          ctx.stroke()
        }

        const showLabel = active && (simNode.radius > 8 || isHovered || isSelected || k > 1.6)
        if (showLabel) {
          ctx.font = `${Math.max(10, 11 / k)}px 'Geist Variable', sans-serif`
          ctx.textAlign = 'center'
          ctx.fillStyle = isHovered || isSelected ? '#f4f4f6' : 'rgba(228,228,232,0.75)'
          ctx.fillText(simNode.node.name, simNode.x, simNode.y + simNode.radius + 12 / k)
        }
      }
      ctx.restore()
    }
    frame = requestAnimationFrame(draw)

    const toWorld = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect()
      const { x, y, k } = state.transform
      return {
        x: (clientX - rect.left - rect.width / 2 - x) / k,
        y: (clientY - rect.top - rect.height / 2 - y) / k,
      }
    }

    const findNode = (clientX: number, clientY: number): SimNode | null => {
      const point = toWorld(clientX, clientY)
      let best: SimNode | null = null
      let bestDist = Infinity
      for (const n of state.simNodes) {
        if (n.x == null || n.y == null) continue
        const dx = n.x - point.x
        const dy = n.y - point.y
        const dist = Math.hypot(dx, dy)
        if (dist < n.radius + 4 && dist < bestDist) {
          best = n
          bestDist = dist
        }
      }
      return best
    }

    const onPointerDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId)
      state.moved = false
      state.lastPointer = { x: e.clientX, y: e.clientY }
      const hit = findNode(e.clientX, e.clientY)
      if (hit) {
        state.dragging = hit
        hit.fx = hit.x
        hit.fy = hit.y
        simRef.current?.alphaTarget(0.25).restart()
      } else {
        state.panning = true
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      const dx = e.clientX - state.lastPointer.x
      const dy = e.clientY - state.lastPointer.y
      if (Math.abs(dx) + Math.abs(dy) > 2) state.moved = true

      if (state.dragging) {
        const point = toWorld(e.clientX, e.clientY)
        state.dragging.fx = point.x
        state.dragging.fy = point.y
      } else if (state.panning) {
        state.transform.x += dx
        state.transform.y += dy
        state.lastPointer = { x: e.clientX, y: e.clientY }
      } else {
        const hit = findNode(e.clientX, e.clientY)
        state.hovered = hit
        canvas.style.cursor = hit ? 'pointer' : 'grab'
      }
      if (state.panning) return
      state.lastPointer = { x: e.clientX, y: e.clientY }
    }

    const onPointerUp = (e: PointerEvent) => {
      if (state.dragging) {
        state.dragging.fx = null
        state.dragging.fy = null
        simRef.current?.alphaTarget(0)
        if (!state.moved) onSelect?.(state.dragging.node)
        state.dragging = null
      } else if (state.panning) {
        state.panning = false
        if (!state.moved) onSelect?.(null)
      }
      canvas.releasePointerCapture(e.pointerId)
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const factor = Math.exp(-e.deltaY * 0.0015)
      const next = Math.min(4, Math.max(0.2, state.transform.k * factor))
      state.transform.k = next
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [onSelect])

  return <canvas ref={canvasRef} className="size-full touch-none" style={{ cursor: 'grab' }} />
}
