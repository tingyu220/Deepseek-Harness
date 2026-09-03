/**
 * Full-frame binary particle backdrop: floating 0/1 glyphs drawn on a canvas
 * behind the columns. Subtle, pointer-transparent, and theme-tinted so it
 * never competes with the conversation surface. Pure presentation — no
 * business data, no subscriptions, no props.
 */
import { useEffect, useRef } from 'react'
import css from './BinaryParticleBackground.module.css'

interface Particle {
  x: number
  y: number
  rise: number
  drift: number
  char: '0' | '1'
  alpha: number
  blink: number
}

export function BinaryParticleBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const color = getComputedStyle(canvas).color
    let width = 0
    let height = 0
    let raf = 0
    const particles: Particle[] = []

    const seed = (): void => {
      particles.length = 0
      const count = Math.max(24, Math.min(90, Math.floor((width * height) / 24000)))
      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          rise: 0.08 + Math.random() * 0.32,
          drift: (Math.random() - 0.5) * 0.24,
          char: Math.random() < 0.5 ? '0' : '1',
          alpha: 0.18 + Math.random() * 0.22,
          blink: Math.random() * Math.PI * 2,
        })
      }
    }

    const resize = (): void => {
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      seed()
    }

    const draw = (): void => {
      ctx.clearRect(0, 0, width, height)
      ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = color
      for (const p of particles) {
        p.y -= p.rise
        p.x += p.drift
        if (p.y < -16) {
          p.y = height + 16
          p.x = Math.random() * width
        }
        if (p.x < -16) p.x = width + 16
        else if (p.x > width + 16) p.x = -16
        ctx.globalAlpha = p.alpha * (0.65 + 0.35 * Math.sin(p.blink))
        ctx.fillText(p.char, p.x, p.y)
      }
      ctx.globalAlpha = 1
    }

    const loop = (): void => {
      draw()
      if (!reduce) raf = requestAnimationFrame(loop)
    }

    resize()
    window.addEventListener('resize', resize)
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={canvasRef} className={css.canvas} aria-hidden="true" />
}
