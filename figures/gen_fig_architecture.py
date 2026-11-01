#!/usr/bin/env python3
"""
Generate publication-quality architecture diagram for dsh-plugin-background-compaction
following academic-plotting (Modern Minimal / Publication Style) guidelines.
Outputs:
  - figures/fig_architecture.png (300 DPI high-resolution for README/GitHub)
  - figures/fig_architecture.svg (scalable vector)
  - figures/fig_architecture.pdf (vector for paper/publication)
"""

import os
import matplotlib.pyplot as plt
import matplotlib.patches as patches

def create_architecture_diagram():
    # Setup publication-grade figure canvas (width=14, height=9.2 inches)
    fig, ax = plt.subplots(figsize=(14.2, 9.4), dpi=300)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.axis("off")
    fig.patch.set_facecolor("#FFFFFF")

    # Typography & styling presets
    FONT_FAMILY = "DejaVu Sans"

    # Color Palette: Modern Minimalist Tech (Ocean Dusk & Slate)
    C_BG_DSH     = "#F8FAFC"
    C_BORDER_DSH = "#94A3B8"
    C_TEXT_DARK  = "#0F172A"
    C_TEXT_MUTED = "#475569"
    C_TEXT_SUB   = "#64748B"

    C_TEAL_BG    = "#F0FDFA"
    C_TEAL_LINE  = "#0D9488"
    C_TEAL_SOLID = "#0F766E"

    C_AMBER_BG   = "#FFFBEB"
    C_AMBER_LINE = "#D97706"
    C_AMBER_TEXT = "#B45309"

    C_EMERALD_BG = "#ECFDF5"
    C_EMERALD_LN = "#10B981"
    C_EMERALD_SD = "#059669"

    C_SLATE_BG   = "#F1F5F9"
    C_SLATE_LN   = "#64748B"

    # Helper: draw rounded card
    def draw_card(x, y, w, h, bg, border, lw=1.5, radius=1.5, zorder=1):
        box = patches.FancyBboxPatch(
            (x, y), w, h,
            boxstyle=f"round,pad=0,rounding_size={radius}",
            facecolor=bg, edgecolor=border, linewidth=lw, zorder=zorder
        )
        ax.add_patch(box)
        return box

    # Helper: draw badge
    def draw_badge(x, y, text, bg, color, fontsize=8):
        ax.text(x, y, text, fontsize=fontsize, fontweight="bold",
                color=color, family=FONT_FAMILY,
                bbox=dict(boxstyle="round,pad=0.28,rounding_size=0.4",
                          facecolor=bg, edgecolor=color, linewidth=0.8),
                ha="center", va="center", zorder=5)

    # Helper: draw labeled connection arrow
    def draw_arrow(x1, y1, x2, y2, color="#475569", lw=1.6, ls="-", label="",
                   label_pos=0.5, label_offset=(0, 1.8), rad=0.0):
        style = patches.ArrowStyle("->", head_length=4.0, head_width=2.5)
        conn = f"arc3,rad={rad}" if rad != 0.0 else "arc3"
        arrow = patches.FancyArrowPatch(
            (x1, y1), (x2, y2),
            arrowstyle=style, connectionstyle=conn,
            color=color, linewidth=lw, linestyle=ls, zorder=4
        )
        ax.add_patch(arrow)
        if label:
            lx = x1 + (x2 - x1) * label_pos + label_offset[0]
            ly = y1 + (y2 - y1) * label_pos + label_offset[1]
            ax.text(lx, ly, label, fontsize=8.2, fontweight="medium",
                    color=color, family=FONT_FAMILY, ha="center", va="center",
                    bbox=dict(boxstyle="round,pad=0.2", facecolor="#FFFFFF",
                              edgecolor="none", alpha=0.9), zorder=6)

    # =========================================================================
    # 0. TITLE & HEADER BAR
    # =========================================================================
    ax.text(50, 96.5, "dsh-plugin-background-compaction: Architecture & Execution Pipeline",
            fontsize=15, fontweight="bold", color="#0F172A", family=FONT_FAMILY, ha="center", va="center")
    ax.text(50, 93.8, "Speculative Background Compaction Engine for DeepSeek Harness (Subclassing BasicCompactionEngine)",
            fontsize=9.5, fontweight="normal", color="#64748B", family=FONT_FAMILY, ha="center", va="center")

    # =========================================================================
    # 1. TOP CONTAINER: DEEPSEEK HARNESS HOST RUNTIME
    # =========================================================================
    draw_card(3, 73, 94, 18, C_BG_DSH, C_BORDER_DSH, lw=1.2, radius=2)
    draw_badge(18, 90, "DeepSeek Harness Host Runtime (Cordis Service Container)", "#E2E8F0", "#334155", fontsize=8.5)

    # Sub-component 1.1: Event-Sourced Surface
    draw_card(5, 75, 27, 12.5, "#FFFFFF", "#CBD5E1", lw=1.2)
    ax.text(18.5, 84.8, "SessionSurface (Event Store)", fontsize=9.5, fontweight="bold", color=C_TEXT_DARK, ha="center")
    ax.text(18.5, 81.2, "Immutable Append-Only Events:\nsystem/message • user/message\nassistant/message • tool/call • tool/result",
            fontsize=7.8, color=C_TEXT_MUTED, ha="center", va="center")
    ax.text(18.5, 76.5, "Folded via compaction/start ... compaction/end",
            fontsize=7.2, color="#0284C7", ha="center", fontstyle="italic")

    # Sub-component 1.2: Agent Pre-Step Lifecycle
    draw_card(35, 75, 29, 12.5, "#FFFFFF", "#CBD5E1", lw=1.2)
    ax.text(49.5, 84.8, "Agent Turn Lifecycle (Hook)", fontsize=9.5, fontweight="bold", color=C_TEXT_DARK, ha="center")
    ax.text(49.5, 81.0, "agent/pre-step (signal, agent)\nIntercepted on each user/tool turn;\nschedules debounced precompute",
            fontsize=7.8, color=C_TEXT_MUTED, ha="center", va="center")
    draw_badge(49.5, 76.6, "ctx.effect Managed Lifecycles", "#F1F5F9", "#475569", fontsize=7.2)

    # Sub-component 1.3: Token Meter & Model Policy
    draw_card(67, 75, 28, 12.5, "#FFFFFF", "#CBD5E1", lw=1.2)
    ax.text(81, 84.8, "Token Meter & Target Policies", fontsize=9.5, fontweight="bold", color=C_TEXT_DARK, ha="center")
    ax.text(81, 80.8, "Dynamic Model Info Resolution\nSupports modelPolicies overrides\nheadroomTokens: 0 + explicit maxTokens",
            fontsize=7.8, color=C_TEXT_MUTED, ha="center", va="center")
    draw_badge(81, 76.6, "Strict Base Contract Parity", "#ECFDF5", C_EMERALD_SD, fontsize=7.2)

    # =========================================================================
    # 2. MIDDLE CONTAINER: SPECULATIVE BACKGROUND COMPACTION ENGINE
    # =========================================================================
    draw_card(3, 34, 94, 34, C_TEAL_BG, C_TEAL_LINE, lw=1.6, radius=2)
    draw_badge(24, 67, "dsh-plugin-background-compaction (ctx.compaction Engine)", "#CCFBF1", C_TEAL_SOLID, fontsize=9)

    # Connect top hook to middle engine
    draw_arrow(49.5, 75, 49.5, 63.5, color=C_TEAL_SOLID, lw=1.8, label="agent/pre-step trigger", label_offset=(0, 2.5))

    # Box 2.1: Spec & Watermark Trigger
    draw_card(5.5, 48, 26.5, 14, "#FFFFFF", C_TEAL_LINE, lw=1.2)
    ax.text(18.7, 59.5, "1. Watermark & Spec Resolver", fontsize=9.2, fontweight="bold", color=C_TEAL_SOLID, ha="center")
    ax.text(18.7, 54.0, "• Threshold = min(W × ratio, budget - headroom)\n• Watermark = 0.72 × threshold\n• Triggers when: tokens ≥ watermark\n  AND tokens < threshold (pre-pressure)",
            fontsize=7.6, color=C_TEXT_MUTED, ha="center", va="center")
    draw_badge(18.7, 49.8, "Per-Model Capacity Aware", "#F0FDFA", C_TEAL_SOLID, fontsize=7)

    # Box 2.2: Span & Boundary Pairing Guard
    draw_card(35, 48, 29, 14, "#FFFFFF", C_TEAL_LINE, lw=1.2)
    ax.text(49.5, 59.5, "2. Span & Pairing Guard", fontsize=9.2, fontweight="bold", color=C_TEAL_SOLID, ha="center")
    ax.text(49.5, 54.0, "• selectPrecomputeRange(session, measurement)\n• Reverse tail accumulation retaining 10%\n• toolPairingBalancedBefore(startIdx)\n• toolPairingBalancedAfter(endIdx)",
            fontsize=7.6, color=C_TEXT_MUTED, ha="center", va="center")
    draw_badge(49.5, 49.8, "Zero Tool Call Splitting", "#FEF3C7", C_AMBER_LINE, fontsize=7)

    # Box 2.3: Circuit Breaker & Stash
    draw_card(67, 48, 28, 14, "#FFFFFF", C_TEAL_LINE, lw=1.2)
    ax.text(81, 59.5, "3. Speculation Gate & Store", fontsize=9.2, fontweight="bold", color=C_TEAL_SOLID, ha="center")
    ax.text(81, 54.0, "• 6-Turn Sliding Window Circuit Breaker\n• Hit rate < 50% ──► 5-min cooldown\n• HeldSummaryStore (5-min TTL, LRU)\n• Async slot reservation (concurrency=1)",
            fontsize=7.6, color=C_TEXT_MUTED, ha="center", va="center")
    draw_badge(81, 49.8, "Prevents Wasted Background LLM Calls", "#F1F5F9", "#475569", fontsize=7)

    # Internal pipeline flow arrows inside Engine
    draw_arrow(32, 55, 35, 55, color=C_TEAL_SOLID, lw=1.5)
    draw_arrow(64, 55, 67, 55, color=C_TEAL_SOLID, lw=1.5)

    # Bottom strip of middle container: SHA-256 Multi-Factor Fingerprinting
    draw_card(5.5, 36.5, 89.5, 8.5, "#F8FAFC", "#94A3B8", lw=1.0)
    ax.text(12.5, 40.7, "Fingerprint Guard:", fontsize=8.8, fontweight="bold", color="#1E293B", ha="left")
    ax.text(28.0, 40.7, "SHA-256 Digest = H( version=bgc-v2  ||  summarizer(provider, model, maxTokens)  ||  tools[]  ||  messages[start..end] )",
            fontsize=7.8, color="#0F766E", family="monospace", ha="left")
    ax.text(50.0, 38.0, "Any prompt drift, tool mutation, or model policy adjustment invalidates held summary instantly before commit",
            fontsize=7.4, color=C_TEXT_SUB, ha="center", fontstyle="italic")

    # =========================================================================
    # 3. BOTTOM SECTION: DUAL-PATH RESOLUTION & COMMITS
    # =========================================================================

    # Path A: Speculative Fast-Path (Left/Center)
    draw_card(3, 4, 60, 26, C_EMERALD_BG, C_EMERALD_LN, lw=1.5, radius=2)
    draw_badge(20, 29, "PATH A: Speculative Zero-Latency Commit (Fast Path)", "#D1FAE5", C_EMERALD_SD, fontsize=8.5)

    # Precompute Worker Box
    draw_card(5.5, 6.5, 26, 19.5, "#FFFFFF", C_AMBER_LINE, lw=1.2)
    ax.text(18.5, 23.5, "Background Worker (Async)", fontsize=8.8, fontweight="bold", color=C_AMBER_TEXT, ha="center")
    ax.text(18.5, 17.0, "• Triggered at 72% watermark\n• Non-blocking background call\n• Prompt Cache prefix reuse\n• Generates SummaryResult\n• Held in memory (5m TTL)",
            fontsize=7.5, color=C_TEXT_MUTED, ha="center", va="center")
    draw_badge(18.5, 8.8, "Held Summary Ready", "#FEF3C7", C_AMBER_TEXT, fontsize=7)

    # Fast Commit Box
    draw_card(34.5, 6.5, 26.5, 19.5, "#FFFFFF", C_EMERALD_SD, lw=1.4)
    ax.text(47.7, 23.5, "Zero-Latency Commit", fontsize=8.8, fontweight="bold", color=C_EMERALD_SD, ha="center")
    ax.text(47.7, 16.8, "• Pressure threshold crossed!\n• Run toolResultPruner\n• Verify Fingerprint + Span\n• Instant compactRegion() call\n• Commit compaction/summary",
            fontsize=7.5, color=C_TEXT_MUTED, ha="center", va="center")
    draw_badge(47.7, 8.8, "0ms Perception Delay", "#D1FAE5", C_EMERALD_SD, fontsize=7.5)

    # Path A internal connection
    draw_arrow(31.5, 16, 34.5, 16, color=C_EMERALD_SD, lw=1.6, label="serve held", label_offset=(0, 2.0))

    # Path B: Fail-Open Resilience (Right)
    draw_card(66, 4, 31, 26, C_SLATE_BG, C_SLATE_LN, lw=1.4, radius=2)
    draw_badge(81.5, 29, "PATH B: Fail-Open Resilience", "#E2E8F0", "#334155", fontsize=8.5)

    draw_card(68, 6.5, 27, 19.5, "#FFFFFF", C_SLATE_LN, lw=1.2)
    ax.text(81.5, 23.5, "Basic Engine Fallback", fontsize=8.8, fontweight="bold", color="#334155", ha="center")
    ax.text(81.5, 16.5, "• Jumps over threshold in 1 step\n• Fingerprint drift on turn change\n• Summary size shrink rejection\n• Delegated to super.compactIfNeeded()\n• Aborts in-flight background worker",
            fontsize=7.5, color=C_TEXT_MUTED, ha="center", va="center")
    draw_badge(81.5, 8.8, "100% Fail-Open Safety", "#F1F5F9", "#475569", fontsize=7)

    # Engine downwards arrows to Path A and Path B
    draw_arrow(25, 34, 18.5, 26.5, color=C_AMBER_LINE, lw=1.6, label="precompute at 72%", label_offset=(-2.5, 0.5))
    draw_arrow(50, 34, 47.7, 26.5, color=C_EMERALD_SD, lw=1.8, label="pressure hit", label_offset=(2.5, 0.5))
    draw_arrow(80, 34, 81.5, 26.5, color=C_SLATE_LN, lw=1.4, ls="--", label="drift / overflow fallback", label_offset=(0, 1.5))

    # Output directory
    out_dir = os.path.dirname(os.path.abspath(__file__))
    png_path = os.path.join(out_dir, "fig_architecture.png")
    svg_path = os.path.join(out_dir, "fig_architecture.svg")
    pdf_path = os.path.join(out_dir, "fig_architecture.pdf")

    plt.savefig(png_path, dpi=300, bbox_inches="tight")
    plt.savefig(svg_path, bbox_inches="tight")
    plt.savefig(pdf_path, bbox_inches="tight")
    plt.close()

    print(f"Generated successfully:")
    print(f"  PNG: {png_path} ({os.path.getsize(png_path):,} bytes)")
    print(f"  SVG: {svg_path} ({os.path.getsize(svg_path):,} bytes)")
    print(f"  PDF: {pdf_path} ({os.path.getsize(pdf_path):,} bytes)")

if __name__ == "__main__":
    create_architecture_diagram()
