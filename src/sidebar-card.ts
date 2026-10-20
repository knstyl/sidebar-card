// ------------------------------------------------------------------------------------------
//  SIDEBAR-CARD
// ------------------------------------------------------------------------------------------
//  https://github.com/DBuit/sidebar-card
// ------------------------------------------------------------------------------------------

// ##########################################################################################
// ###   Global constants
// ##########################################################################################

const SIDEBAR_CARD_TITLE = 'SIDEBAR-CARD';
const SIDEBAR_CARD_VERSION = '0.2.6';

// ##########################################################################################
// ###   Import dependencies
// ##########################################################################################

import { css, html, svg, LitElement } from 'lit-element';
import { repeat } from 'lit-html/directives/repeat';
import { moreInfo } from 'card-tools/src/more-info';
import { hass, provideHass } from 'card-tools/src/hass';
import { subscribeRenderTemplate } from 'card-tools/src/templates';
import moment from 'moment/min/moment-with-locales';
import { forwardHaptic, navigate, toggleEntity } from 'custom-card-helpers';


// ##########################################################################################
// ###   Notifications Element
// ##########################################################################################
interface HassEntity {
  entity_id: string;
  state: string;
  attributes: any;
}

interface HassStates {
  [entity_id: string]: HassEntity;
}

interface Hass {
  states: HassStates;
  callService: (domain: string, service: string, data?: any) => void;
  language?: string;
}

interface NotificationEntity {
  notification_id: string;
  title: string;
  message: string;
  created_at: string;
}

type NotificationSeverity = 'error' | 'warning' | 'info' | 'success';

interface NotificationGroup {
  key: string;
  ids: string[];
  title: string;
  message: string;
  created_at: string;
  severity: NotificationSeverity;
}

const NOTIFICATION_SEVERITY_RANK: { [key in NotificationSeverity]: number } = {
  error: 0,
  warning: 1,
  info: 2,
  success: 3
};

// Close the panel by itself after this long without interaction, so a wall
// tablet never stays stuck on the notification list.
const NOTIFICATION_PANEL_IDLE_MS = 30000;
const NOTIFICATION_DISMISS_ANIMATION_MS = 200;
const NOTIFICATION_STACK_PEEK_PX = 9;

const NOTIFICATION_ICONS: { [key in NotificationSeverity]: any } = {
  error: svg`<circle cx="12" cy="12" r="10"></circle><path d="M15 9l-6 6M9 9l6 6"></path>`,
  warning: svg`<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path><path d="M12 9v4M12 17h.01"></path>`,
  info: svg`<circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4M12 8h.01"></path>`,
  success: svg`<circle cx="12" cy="12" r="10"></circle><path d="m8 12 3 3 5-6"></path>`
};

const CLOSE_ICON = html`
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <path d="M18 6 6 18M6 6l12 12"></path>
  </svg>
`;

class NotificationsElement extends LitElement {
  hass: any;
  notifications: NotificationEntity[] = [];
  open = false;

  private _byId: Map<string, NotificationEntity> = new Map();
  private _unsubscribe: (() => void) | null = null;
  private _subscribing = false;
  private _expandedKeys: Set<string> = new Set();
  private _dismissingKeys: Set<string> = new Set();
  private _idleTimer: number | null = null;
  private _clockTimer: number | null = null;
  private _sidebarInner: HTMLElement | null = null;
  private _sidebarOverflow = '';
  private _onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.open) this._setOpen(false);
  };

  /* **************************************** *
   *        Element's public properties       *
   * **************************************** */
  static get properties() {
    return {
      hass: { type: Object },
      notifications: { type: Array, attribute: false },
      open: { type: Boolean, reflect: true }
    };
  }

  constructor() {
    super();
    this.hass = null;
    this.notifications = [];
  }

  connectedCallback() {
    super.connectedCallback();
    // keep the "10m ago" labels fresh
    this._clockTimer = window.setInterval(() => {
      if (this.notifications.length) this.requestUpdate();
    }, 60000);
  }

  protected updated(changedProperties): void {
    if (changedProperties.has('hass') && this.hass?.connection && !this._unsubscribe && !this._subscribing) {
      this._subscribeNotifications();
    }
    if (changedProperties.has('notifications') && this.open && this.notifications.length === 0) {
      this._setOpen(false);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._clockTimer) window.clearInterval(this._clockTimer);
    this._clockTimer = null;
    if (this.open) this._setOpen(false);
  }

  /* **************************************** *
   *               Subscription               *
   * **************************************** */

  private async _subscribeNotifications(): Promise<void> {
    this._subscribing = true;
    try {
      this._unsubscribe = await this.hass.connection.subscribeMessage(
        (message: any) => this._handleMessage(message),
        { type: 'persistent_notification/subscribe' }
      );
    } catch (err) {
      console.warn('sidebar-card: could not subscribe to notifications', err);
    } finally {
      this._subscribing = false;
    }
  }

  // Key everything by notification_id: HA re-sends an existing id as `added`
  // or `updated` (e.g. repeated failed logins reuse `http-login`), so appending
  // would render the same notification more than once.
  private _handleMessage(message: any): void {
    const changed = (Object.values(message.notifications || {}) as NotificationEntity[]);
    if (message.type === 'current') {
      this._byId.clear();
    }
    if (message.type === 'removed') {
      Object.keys(message.notifications || {}).forEach(id => this._byId.delete(id));
    } else {
      changed.forEach(n => this._byId.set(n.notification_id, n));
    }
    this.notifications = Array.from(this._byId.values());
  }

  /* **************************************** *
   *                 Helpers                  *
   * **************************************** */

  private _severity(n: NotificationEntity): NotificationSeverity {
    const text = `${n.title || ''} ${n.notification_id || ''}`.toLowerCase();
    if (/invalid|error|failed|http-login|unavailable|offline/.test(text)) return 'error';
    if (/success|completed|finished/.test(text)) return 'success';
    if (/update|available|discover|new device|release/.test(text)) return 'info';
    return 'warning';
  }

  // Same title = same thing happening again; show it once with a count.
  private _groups(): NotificationGroup[] {
    const groups = new Map<string, NotificationGroup>();
    this.notifications.forEach(n => {
      const key = (n.title || n.notification_id).trim();
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          key,
          ids: [n.notification_id],
          title: n.title || 'Notification',
          message: n.message,
          created_at: n.created_at,
          severity: this._severity(n)
        });
        return;
      }
      existing.ids.push(n.notification_id);
      if (new Date(n.created_at).getTime() > new Date(existing.created_at).getTime()) {
        existing.created_at = n.created_at;
        existing.message = n.message;
      }
    });
    // Most severe first, then newest: a failed login stays on top of the stack
    // even if an update notice arrives after it.
    return Array.from(groups.values()).sort(
      (a, b) =>
        NOTIFICATION_SEVERITY_RANK[a.severity] - NOTIFICATION_SEVERITY_RANK[b.severity] ||
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }

  private _getTimeAgo(createdAt: string): string {
    const diffInMinutes = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000);
    if (isNaN(diffInMinutes) || diffInMinutes < 1) return 'Just now';
    if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
    const diffInHours = Math.floor(diffInMinutes / 60);
    if (diffInHours < 24) return `${diffInHours}h ago`;
    return `${Math.floor(diffInHours / 24)}d ago`;
  }

  // Notification text comes from integrations and automations, so escape it
  // first and then allow only a small markdown subset (bold, code, links, bullets).
  private _formatMessage(message: string): string {
    if (!message) return '';
    const escape = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const inline = (s: string) =>
      escape(s)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => {
          if (/^https?:\/\//i.test(href)) return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
          if (href.startsWith('/')) return `<a href="${href}">${text}</a>`;
          return text;
        });

    return message
      .split('\n')
      .map(line => line.trim())
      .filter(line => line)
      .map(line => {
        const bullet = line.match(/^(?:[•*-])\s+(.*)$/);
        return bullet ? `<div class="bullet-point">• ${inline(bullet[1])}</div>` : `<div>${inline(line)}</div>`;
      })
      .join('');
  }

  /* **************************************** *
   *                 Actions                  *
   * **************************************** */

  private _dismissGroup(group: NotificationGroup, e?: Event): void {
    if (e) e.stopPropagation();
    if (!this.hass || this._dismissingKeys.has(group.key)) return;
    this._dismissingKeys.add(group.key);
    this.requestUpdate();
    window.setTimeout(() => {
      group.ids.forEach(id =>
        this.hass.callService('persistent_notification', 'dismiss', { notification_id: id })
      );
      this._dismissingKeys.delete(group.key);
      this._expandedKeys.delete(group.key);
      this.requestUpdate();
    }, NOTIFICATION_DISMISS_ANIMATION_MS);
  }

  private _dismissAll(): void {
    if (!this.hass) return;
    this.notifications.forEach(n =>
      this.hass.callService('persistent_notification', 'dismiss', { notification_id: n.notification_id })
    );
  }

  private _toggleMessage(group: NotificationGroup, e: Event): void {
    if ((e.target as HTMLElement).closest('a')) return; // let links work
    if (this._expandedKeys.has(group.key)) this._expandedKeys.delete(group.key);
    else this._expandedKeys.add(group.key);
    this.requestUpdate();
  }

  private _onStackActivate(e: Event): void {
    if ((e.target as HTMLElement).closest('a')) return;
    this._setOpen(true);
  }

  private _onStackKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this._setOpen(true);
    }
  }

  private _setOpen(open: boolean): void {
    if (open === this.open) return;
    if (open) {
      // .sidebar-inner is position:fixed, so it is the containing block for the
      // absolutely positioned panel. It also scrolls, so pin the panel to the
      // visible area and lock scrolling while the panel is open.
      this._sidebarInner = this.closest('.sidebar-inner') as HTMLElement | null;
      if (this._sidebarInner) {
        this.style.setProperty('--ns-panel-top', `${this._sidebarInner.scrollTop}px`);
        this._sidebarOverflow = this._sidebarInner.style.overflow;
        this._sidebarInner.style.overflow = 'hidden';
      }
      window.addEventListener('keydown', this._onKeyDown);
      this.open = true;
      this._bumpIdle();
      this.updateComplete.then(() => {
        const close = this.shadowRoot?.querySelector('.panel-close') as HTMLElement | null;
        if (close) close.focus({ preventScroll: true });
      });
    } else {
      this.open = false;
      if (this._sidebarInner) this._sidebarInner.style.overflow = this._sidebarOverflow;
      this._sidebarInner = null;
      window.removeEventListener('keydown', this._onKeyDown);
      if (this._idleTimer) window.clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  private _bumpIdle(): void {
    if (!this.open) return;
    if (this._idleTimer) window.clearTimeout(this._idleTimer);
    this._idleTimer = window.setTimeout(() => this._setOpen(false), NOTIFICATION_PANEL_IDLE_MS);
  }

  /* **************************************** *
   *                 Rendering                *
   * **************************************** */

  private _renderCard(group: NotificationGroup, opts: { inStack: boolean; moreCount?: number }) {
    const expanded = this._expandedKeys.has(group.key);
    const classes = [
      'card',
      group.severity,
      expanded ? 'expanded' : '',
      this._dismissingKeys.has(group.key) ? 'dismissing' : ''
    ].join(' ');
    return html`
      <div class="${classes}">
        <div class="card-head">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            ${NOTIFICATION_ICONS[group.severity]}
          </svg>
          <div class="title-wrap">
            <h3 class="title">
              ${group.title}${group.ids.length > 1 ? html`<span class="count-pill">×${group.ids.length}</span>` : ''}
            </h3>
            <div class="meta">${this._getTimeAgo(group.created_at)}</div>
          </div>
          <button class="card-close" aria-label="Dismiss ${group.title}"
            @click="${(e: Event) => this._dismissGroup(group, e)}">
            ${CLOSE_ICON}
          </button>
        </div>
        <div class="msg" .innerHTML="${this._formatMessage(group.message)}"
          @click="${opts.inStack ? null : (e: Event) => this._toggleMessage(group, e)}"></div>
        ${opts.moreCount
          ? html`
              <div class="stack-hint">
                <span class="more">+${opts.moreCount} more</span>
                <span>Tap to view all</span>
              </div>
            `
          : ''}
      </div>
    `;
  }

  private _renderPanel(groups: NotificationGroup[]) {
    return html`
      <div class="panel ${this.open ? 'open' : ''}" role="dialog" aria-modal="true"
        aria-labelledby="ns-panel-title" aria-hidden="${this.open ? 'false' : 'true'}"
        @pointerdown="${this._bumpIdle}" @scroll="${this._bumpIdle}">
        <div class="panel-inner">
          <div class="panel-head">
            <h2 id="ns-panel-title">Notifications<span class="panel-count">${groups.length}</span></h2>
            <button class="panel-close" aria-label="Close notifications" @click="${() => this._setOpen(false)}">
              ${CLOSE_ICON}
            </button>
          </div>
          <div class="panel-list" @scroll="${this._bumpIdle}">
            ${repeat(groups, g => g.key, g => this._renderCard(g, { inStack: false }))}
          </div>
          <div class="panel-foot">
            <button class="clear-all" @click="${this._dismissAll}">Clear all</button>
          </div>
        </div>
      </div>
    `;
  }

  protected render() {
    const groups = this._groups();
    if (!groups.length) return html``;

    const stacked = groups.length > 1;
    // only the first three can be seen in the stack; the rest live in the panel
    const visible = stacked ? groups.slice(0, 3) : groups;
    const peek = stacked ? Math.min(groups.length - 1, 2) * NOTIFICATION_STACK_PEEK_PX : 0;

    return html`
      <div class="ns ${stacked ? 'stacked' : 'single'}">
        ${stacked
          ? html`
              <div class="ns-list" style="--peek: ${peek}px" role="button" tabindex="0"
                aria-label="Show all ${groups.length} notifications"
                @click="${this._onStackActivate}" @keydown="${this._onStackKeyDown}">
                ${repeat(visible, g => g.key, (g, i) =>
                  this._renderCard(g, { inStack: true, moreCount: i === 0 ? groups.length - 1 : 0 })
                )}
              </div>
            `
          : html`
              <div class="ns-list">
                ${repeat(visible, g => g.key, g => this._renderCard(g, { inStack: false }))}
              </div>
            `}
      </div>
      ${stacked || this.open ? this._renderPanel(groups) : ''}
    `;
  }

  static get styles() {
    return css`
      :host {
        display: block;
        width: 100%;
        /* themable; override from the card's style: option */
        --ns-text: var(--sidebar-text-color, #f1f5f9);
        --ns-text-2: rgba(241, 245, 249, 0.72);
        --ns-text-3: rgba(241, 245, 249, 0.5);
        --ns-card-bg: var(--sidebar-notification-background, #18263f);
        --ns-card-border: rgba(255, 255, 255, 0.08);
        --ns-scrim: var(--sidebar-notification-scrim, rgba(9, 16, 31, 0.86));
        --ns-error: #ef4444;
        --ns-warning: #f59e0b;
        --ns-info: #3b82f6;
        --ns-success: #10b981;
        /* no position here: the panel must resolve against .sidebar-inner */
      }

      .ns {
        margin: 0;
      }

      .ns-list {
        position: relative;
        display: grid;
      }

      .ns.stacked .ns-list {
        cursor: pointer;
        padding-bottom: var(--peek, 0px);
        border-radius: 14px;
        outline: none;
      }

      .ns.stacked .ns-list:focus-visible {
        box-shadow: 0 0 0 2px var(--ns-info);
      }

      /* ---------- card ---------- */
      .card {
        --sev: var(--ns-warning);
        position: relative;
        grid-area: 1 / 1;
        background: linear-gradient(
            color-mix(in srgb, var(--sev) 10%, transparent),
            color-mix(in srgb, var(--sev) 10%, transparent)
          ),
          var(--ns-card-bg);
        border: 1px solid var(--ns-card-border);
        border-radius: 14px;
        padding: 12px 8px 12px 14px;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
        overflow: hidden;
        transform-origin: bottom center;
        flex-shrink: 0;
        transition: transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.28s ease;
      }

      /* severity accent bar */
      .card::before {
        content: '';
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 3px;
        background: var(--sev);
      }

      .card.error {
        --sev: var(--ns-error);
      }
      .card.warning {
        --sev: var(--ns-warning);
      }
      .card.info {
        --sev: var(--ns-info);
      }
      .card.success {
        --sev: var(--ns-success);
      }

      .card.dismissing {
        opacity: 0 !important;
        transform: translateX(40px) !important;
      }

      /* ---------- stacked: cards share one grid cell, back cards peek out ---------- */
      .ns.stacked .card:nth-child(1) {
        z-index: 3;
      }
      .ns.stacked .card:nth-child(2) {
        z-index: 2;
        transform: translateY(9px) scale(0.95);
        opacity: 0.9;
      }
      .ns.stacked .card:nth-child(3) {
        z-index: 1;
        transform: translateY(18px) scale(0.9);
        opacity: 0.65;
      }
      /* back cards are just edges: take them out of flow so only the front
         card sets the stack's height */
      .ns.stacked .card:not(:first-child) {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: calc(100% - var(--peek, 0px));
        box-sizing: border-box;
      }
      .ns.stacked .card:not(:first-child) * {
        visibility: hidden;
      }

      .card-head {
        display: flex;
        align-items: flex-start;
        gap: 10px;
      }

      .icon {
        width: 18px;
        height: 18px;
        flex-shrink: 0;
        margin-top: 1px;
        color: var(--sev);
      }

      .title-wrap {
        flex: 1;
        min-width: 0;
      }

      .title {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        line-height: 1.35;
        color: var(--ns-text);
      }

      .meta {
        font-size: 12px;
        color: var(--ns-text-3);
        margin-top: 2px;
      }

      .count-pill {
        font-size: 11px;
        font-weight: 700;
        padding: 2px 7px;
        border-radius: 999px;
        background: var(--sev);
        color: #0b1220;
        margin-left: 6px;
        vertical-align: 1px;
      }

      .card-close {
        width: 32px;
        height: 32px;
        margin: -6px -2px 0 0;
        flex-shrink: 0;
        display: grid;
        place-items: center;
        border-radius: 8px;
        background: none;
        border: none;
        padding: 0;
        color: var(--ns-text-3);
        cursor: pointer;
      }

      .card-close:active {
        background: rgba(255, 255, 255, 0.1);
        color: var(--ns-text);
      }

      .card-close svg,
      .panel-close svg {
        width: 16px;
        height: 16px;
      }

      .msg {
        margin: 8px 6px 0 28px;
        font-size: 13px;
        line-height: 1.45;
        color: var(--ns-text-2);
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
        word-break: break-word;
      }

      .ns.single .msg,
      .panel .msg {
        cursor: pointer;
      }

      .card.expanded .msg {
        -webkit-line-clamp: unset;
        display: block;
      }

      .msg .bullet-point {
        margin-left: 4px;
      }

      .msg a {
        color: var(--ns-text);
      }

      .msg code {
        font-size: 12px;
        padding: 0 4px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.08);
      }

      .stack-hint {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin: 10px 6px 0 28px;
        font-size: 12px;
        color: var(--ns-text-3);
      }

      .more {
        color: var(--ns-text-2);
        font-weight: 500;
      }

      /* ---------- panel: covers the whole sidebar ---------- */
      .panel {
        position: absolute;
        left: 0;
        right: 0;
        top: var(--ns-panel-top, 0px);
        height: 100%;
        z-index: 100;
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        padding: 16px 12px 12px;
        background: var(--ns-scrim);
        -webkit-backdrop-filter: blur(6px);
        backdrop-filter: blur(6px);
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.22s ease, visibility 0s linear 0.22s;
      }

      .panel.open {
        opacity: 1;
        visibility: visible;
        transition: opacity 0.22s ease;
      }

      .panel-inner {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        transform: translateY(32px) scale(0.97);
        transform-origin: top center;
        transition: transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
      }

      .panel.open .panel-inner {
        transform: none;
      }

      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 2px 12px 6px;
        flex-shrink: 0;
      }

      .panel-head h2 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        color: var(--ns-text);
      }

      .panel-count {
        font-size: 12px;
        font-weight: 700;
        padding: 2px 8px;
        border-radius: 999px;
        margin-left: 8px;
        background: rgba(255, 255, 255, 0.12);
        color: var(--ns-text-2);
        vertical-align: 2px;
      }

      .panel-close {
        width: 44px;
        height: 44px;
        display: grid;
        place-items: center;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.08);
        border: none;
        padding: 0;
        color: var(--ns-text);
        cursor: pointer;
      }

      .panel-close svg {
        width: 20px;
        height: 20px;
      }

      .panel-close:active {
        background: rgba(255, 255, 255, 0.16);
      }

      .panel-list {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 2px 2px 12px;
        scrollbar-width: thin;
      }

      .panel-list .card {
        grid-area: auto;
      }

      .panel-foot {
        flex-shrink: 0;
        padding-top: 8px;
        border-top: 1px solid var(--ns-card-border);
      }

      .clear-all {
        width: 100%;
        min-height: 44px;
        border-radius: 12px;
        cursor: pointer;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid var(--ns-card-border);
        color: var(--ns-text-2);
        font: inherit;
        font-size: 14px;
        font-weight: 500;
      }

      .clear-all:active {
        background: rgba(255, 255, 255, 0.12);
        color: var(--ns-text);
      }

      @media (prefers-reduced-motion: reduce) {
        .card,
        .panel,
        .panel-inner {
          transition: none;
        }
      }
    `;
  }
}

customElements.define('notifications-element', NotificationsElement);


// ##########################################################################################
// ###   Glance Bar - at-a-glance status icons
// ##########################################################################################

type GlanceConditionType =
  | 'always' | 'state' | 'state_not'
  | 'numeric_above' | 'numeric_below'
  | 'time_after' | 'time_before'
  | 'sun_below_horizon' | 'sun_above_horizon';

interface GlanceCondition {
  condition: GlanceConditionType;
  entity?: string;
  state?: string | string[];
  threshold?: number;
  after?: string;
  before?: string;
}

interface GlanceBadge {
  condition?: GlanceConditionType;
  entity?: string;
  state?: string | string[];
  threshold?: number;
  after?: string;
  before?: string;
  icon?: string;
  color?: string;
  label?: 'state' | 'attribute';
  label_attribute?: string;
  label_max_length?: number;
}

type GlanceTone = 'alert' | 'warning' | 'info';

interface GlanceToneThresholds {
  warn_above?: number;
  alert_above?: number;
  warn_below?: number;
  alert_below?: number;
}

interface GlanceItem {
  entity: string;
  icon: string;
  name?: string;
  color?: string;
  show?: GlanceCondition | GlanceConditionType;
  badge?: GlanceBadge;
  // alerts mode: text for the row; supports {name}, {state} and {unit}
  label?: string;
  // alerts mode: fixed tone, or thresholds on the entity's numeric state
  tone?: GlanceTone | GlanceToneThresholds;
  tap_action?: { action: string; entity?: string; navigation_path?: string; url_path?: string };
}

type GlancePosition = 'bottom' | 'attention';

interface GlanceBarConfig {
  position?: GlancePosition;
  items?: GlanceItem[];
}

const GLANCE_TONE_RANK: { [key in GlanceTone]: number } = { alert: 0, warning: 1, info: 2 };
// alerts beyond this fold into a "+N more" row
const GLANCE_ALERTS_VISIBLE = 2;

// `glanceBar` accepts the original list form (icon bar pinned to the bottom)
// or { position, items }.
function normalizeGlanceBar(config: GlanceItem[] | GlanceBarConfig | null | undefined): { position: GlancePosition; items: GlanceItem[] } {
  if (!config) return { position: 'bottom', items: [] };
  if (Array.isArray(config)) return { position: 'bottom', items: config };
  return {
    position: config.position === 'attention' ? 'attention' : 'bottom',
    items: Array.isArray(config.items) ? config.items : []
  };
}

class GlanceBarElement extends LitElement {
  hass: any;
  items: GlanceItem[] = [];
  mode: 'icons' | 'alerts' = 'icons';
  private _expanded = false;
  private _tickInterval: any = null;

  static get properties() {
    return {
      hass: { type: Object },
      items: { type: Array },
      mode: { type: String, reflect: true },
      _expanded: { attribute: false }
    };
  }

  connectedCallback() {
    super.connectedCallback();
    this._tickInterval = setInterval(() => this.requestUpdate(), 30000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this._tickInterval);
    this._tickInterval = null;
  }

  private _minutesNow(): number {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  private _parseMinutes(timeStr: string): number {
    const [h, m] = timeStr.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  private _evalCondition(cond: GlanceCondition | GlanceConditionType | undefined, defaultEntity: string): boolean {
    if (!cond || cond === 'always') return true;

    const c: GlanceCondition = typeof cond === 'string' ? { condition: cond } : cond;
    const entityId = c.entity || defaultEntity;
    const entityState = this.hass?.states?.[entityId];

    switch (c.condition) {
      case 'always': return true;
      case 'state': {
        if (!entityState) return false;
        const targets = Array.isArray(c.state) ? c.state : [c.state as string];
        return targets.includes(entityState.state);
      }
      case 'state_not': {
        if (!entityState) return true;
        const targets = Array.isArray(c.state) ? c.state : [c.state as string];
        return !targets.includes(entityState.state);
      }
      case 'numeric_above':
        return entityState && c.threshold !== undefined ? parseFloat(entityState.state) > c.threshold : false;
      case 'numeric_below':
        return entityState && c.threshold !== undefined ? parseFloat(entityState.state) < c.threshold : false;
      case 'time_after':
        return c.after ? this._minutesNow() >= this._parseMinutes(c.after) : false;
      case 'time_before':
        return c.before ? this._minutesNow() < this._parseMinutes(c.before) : false;
      case 'sun_below_horizon':
        return this.hass?.states?.['sun.sun']?.state === 'below_horizon';
      case 'sun_above_horizon':
        return this.hass?.states?.['sun.sun']?.state === 'above_horizon';
      default:
        return false;
    }
  }

  private _evalBadge(badge: GlanceBadge | undefined, defaultEntity: string): boolean {
    if (!badge) return false;
    return this._evalCondition({
      condition: badge.condition || 'always',
      entity: badge.entity,
      state: badge.state,
      threshold: badge.threshold,
      after: badge.after,
      before: badge.before,
    }, defaultEntity);
  }

  private _getBadgeLabel(badge: GlanceBadge | undefined, defaultEntity: string): string | null {
    if (!badge?.label) return null;
    const entityId = badge.entity || defaultEntity;
    const entityState = this.hass?.states?.[entityId];
    if (!entityState) return null;

    const raw = badge.label === 'attribute' && badge.label_attribute
      ? String(entityState.attributes[badge.label_attribute] ?? '')
      : entityState.state;

    const max = badge.label_max_length ?? 3;
    return raw.length > max ? raw.slice(0, max) : raw;
  }

  private _handleClick(e: Event, item: GlanceItem) {
    e.stopPropagation();
    const action = item.tap_action;
    if (!action || action.action === 'more-info') {
      moreInfo(action?.entity || item.entity);
      return;
    }
    switch (action.action) {
      case 'navigate':
        if (action.navigation_path) navigate(window, action.navigation_path);
        break;
      case 'toggle':
        toggleEntity(this.hass, action.entity || item.entity);
        forwardHaptic('success');
        break;
      case 'url':
        if (action.url_path) window.open(action.url_path);
        break;
    }
  }

  private _tone(item: GlanceItem): GlanceTone {
    const tone = item.tone;
    if (!tone) return 'alert';
    if (typeof tone === 'string') return GLANCE_TONE_RANK[tone] !== undefined ? tone : 'alert';
    const value = parseFloat(this.hass?.states?.[item.entity]?.state);
    if (isNaN(value)) return 'info';
    if ((tone.alert_above !== undefined && value > tone.alert_above) ||
        (tone.alert_below !== undefined && value < tone.alert_below)) return 'alert';
    if ((tone.warn_above !== undefined && value > tone.warn_above) ||
        (tone.warn_below !== undefined && value < tone.warn_below)) return 'warning';
    return 'info';
  }

  private _alertLabel(item: GlanceItem): string {
    const entityState = this.hass.states[item.entity];
    const name = item.name || entityState?.attributes?.friendly_name || item.entity;
    if (!item.label) return name;
    return item.label
      .replace(/\{name\}/g, name)
      .replace(/\{state\}/g, entityState?.state ?? '')
      .replace(/\{unit\}/g, entityState?.attributes?.unit_of_measurement ?? '')
      .trim();
  }

  // "how long has the door been open"
  private _since(lastChanged: string | undefined): string {
    if (!lastChanged) return '';
    const mins = Math.floor((Date.now() - new Date(lastChanged).getTime()) / 60000);
    if (isNaN(mins) || mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
  }

  private _renderAlerts(visible: GlanceItem[]) {
    const sorted = visible
      .map((item, index) => ({ item, index, tone: this._tone(item) }))
      .sort((a, b) => GLANCE_TONE_RANK[a.tone] - GLANCE_TONE_RANK[b.tone] || a.index - b.index);
    const shown = this._expanded ? sorted : sorted.slice(0, GLANCE_ALERTS_VISIBLE);
    const hidden = sorted.length - shown.length;

    return html`
      <div class="alerts" role="list">
        ${shown.map(({ item, tone }) => {
          const entityState = this.hass.states[item.entity];
          const label = this._alertLabel(item);
          return html`
            <button class="alert ${tone}" role="listitem" title="${label}"
              @click="${(e) => this._handleClick(e, item)}">
              <ha-icon icon="${item.icon}"></ha-icon>
              <span class="alert-label">${label}</span>
              <span class="alert-since">${this._since(entityState?.last_changed)}</span>
            </button>
          `;
        })}
        ${hidden > 0 || this._expanded && sorted.length > GLANCE_ALERTS_VISIBLE
          ? html`
              <button class="alert-more" @click="${() => { this._expanded = !this._expanded; }}">
                ${this._expanded ? 'Show less' : `+${hidden} more alert${hidden === 1 ? '' : 's'}`}
              </button>
            `
          : ''}
      </div>
    `;
  }

  protected render() {
    if (!this.hass || !this.items?.length) return html``;

    const visible = this.items.filter(item =>
      this.hass.states[item.entity] !== undefined &&
      this._evalCondition(item.show, item.entity)
    );

    if (!visible.length) return html``;

    if (this.mode === 'alerts') return this._renderAlerts(visible);

    return html`
      <div class="glance-bar">
        ${visible.map(item => {
          const entityState = this.hass.states[item.entity];
          const label = item.name || entityState?.attributes?.friendly_name || item.entity;
          const showBadge = this._evalBadge(item.badge, item.entity);
          const badgeColor = item.badge?.color ?? '#ef4444';
          const badgeIcon = item.badge?.icon;
          const badgeLabel = showBadge ? this._getBadgeLabel(item.badge, item.entity) : null;

          return html`
            <div
              class="glance-item${showBadge ? ' has-badge' : ''}"
              title="${label}: ${entityState?.state ?? ''}"
              @click="${(e) => this._handleClick(e, item)}"
            >
              <ha-icon
                icon="${item.icon}"
                style="${item.color ? `color: ${item.color}` : ''}"
              ></ha-icon>
              ${showBadge ? html`
                <span class="glance-badge" style="--badge-color: ${badgeColor}">
                  ${badgeIcon ? html`<ha-icon icon="${badgeIcon}" class="badge-icon"></ha-icon>` : html``}
                  ${badgeLabel ? html`<span class="badge-label">${badgeLabel}</span>` : html``}
                </span>
              ` : html``}
            </div>
          `;
        })}
      </div>
    `;
  }

  static get styles() {
    return css`
      :host {
        display: block;
        position: sticky;
        bottom: 0;
        z-index: 100;
        /* pushes bar to bottom of the flex column when content is shorter than the sidebar */
        margin-top: auto;
      }

      :host::before {
        content: '';
        position: absolute;
        top: -32px;
        left: 0;
        right: 0;
        height: 32px;
        /* fades into whatever background the bar uses; invisible when bar is transparent */
        background: linear-gradient(to bottom, transparent, var(--glance-bar-background, transparent));
        pointer-events: none;
      }

      .glance-bar {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 8px;
        padding: 8px 0 16px;
        background: var(--glance-bar-background, transparent);
        border-top: var(--glance-bar-border-top, none);
      }

      .glance-item {
        position: relative;
        width: 44px;
        height: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--sidebar-card-background, rgba(255, 255, 255, 0.06));
        border: 1px solid var(--sidebar-border-color, rgba(255, 255, 255, 0.1));
        border-radius: 12px;
        cursor: pointer;
        transition: transform 0.2s ease, background 0.2s ease;
      }

      .glance-item:hover {
        background: rgba(255, 255, 255, 0.12);
        transform: scale(1.08);
      }

      .glance-item ha-icon {
        color: var(--sidebar-icon-color, rgba(255, 255, 255, 0.85));
        --mdc-icon-size: 22px;
        display: flex;
      }

      .glance-item.has-badge ha-icon {
        color: var(--sidebar-selected-icon-color, #60a5fa);
      }

      .glance-badge {
        position: absolute;
        top: -5px;
        right: -5px;
        min-width: 14px;
        height: 14px;
        border-radius: 7px;
        background: var(--badge-color, #ef4444);
        border: 2px solid var(--sidebar-background, var(--primary-background-color, #111));
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0 2px;
        box-sizing: border-box;
        gap: 1px;
      }

      .badge-icon {
        --mdc-icon-size: 8px;
        color: #fff;
        flex-shrink: 0;
      }

      .badge-label {
        font-size: 9px;
        font-weight: 700;
        color: #fff;
        line-height: 1;
        white-space: nowrap;
        letter-spacing: -0.02em;
      }

      /* ---------- alerts mode: slim rows in the Attention zone ---------- */
      :host([mode='alerts']) {
        position: static;
        margin-top: 0;
      }

      :host([mode='alerts'])::before {
        display: none;
      }

      .alerts {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-bottom: 8px;
      }

      .alert {
        --sev: #ef4444;
        position: relative;
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        min-height: 44px;
        padding: 0 12px 0 14px;
        box-sizing: border-box;
        overflow: hidden;
        text-align: left;
        cursor: pointer;
        font: inherit;
        color: var(--sidebar-text-color, #f1f5f9);
        background: linear-gradient(
            color-mix(in srgb, var(--sev) 14%, transparent),
            color-mix(in srgb, var(--sev) 14%, transparent)
          ),
          var(--sidebar-notification-background, #18263f);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
      }

      .alert::before {
        content: '';
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 3px;
        background: var(--sev);
      }

      .alert.warning {
        --sev: #f59e0b;
      }

      .alert.info {
        --sev: #3b82f6;
      }

      .alert:active {
        filter: brightness(1.15);
      }

      .alert ha-icon {
        --mdc-icon-size: 20px;
        color: var(--sev);
        flex-shrink: 0;
        display: flex;
      }

      .alert-label {
        flex: 1;
        min-width: 0;
        font-size: 14px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .alert-since {
        font-size: 12px;
        color: rgba(241, 245, 249, 0.5);
        flex-shrink: 0;
      }

      .alert-more {
        align-self: flex-start;
        min-height: 32px;
        padding: 0 8px;
        background: none;
        border: none;
        border-radius: 8px;
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        color: rgba(241, 245, 249, 0.72);
        cursor: pointer;
      }

      .alert-more:active {
        background: rgba(255, 255, 255, 0.08);
      }
    `;
  }
}

customElements.define('glance-bar-element', GlanceBarElement);

// ##########################################################################################
// ###   Presence - avatars for person entities, shown on the weather row
// ##########################################################################################

interface PresenceEntry {
  entity: string;
  name?: string;
}

class PresenceElement extends LitElement {
  hass: any;
  entities: (string | PresenceEntry)[] = [];
  compact = false;

  static get properties() {
    return { hass: { type: Object }, entities: { type: Array }, compact: { type: Boolean, reflect: true } };
  }

  private _initials(name: string): string {
    return name
      .split(/\s+/)
      .filter(part => part)
      .slice(0, 2)
      .map(part => part[0].toUpperCase())
      .join('');
  }

  protected render() {
    if (!this.hass || !this.entities?.length) return html``;

    const people = this.entities
      .map(entry => (typeof entry === 'string' ? { entity: entry } : entry))
      .filter(entry => entry && this.hass.states[entry.entity]);
    if (!people.length) return html``;

    return html`
      <div class="people ${people.length > 2 || (this.compact && people.length > 1) ? 'overlap' : ''}">
        ${people.map(entry => {
          const st = this.hass.states[entry.entity];
          const name = entry.name || st.attributes?.friendly_name || entry.entity;
          const where = st.state === 'home' ? 'home' : st.state === 'not_home' ? 'away' : 'zone';
          const whereText = where === 'home' ? 'Home' : where === 'away' ? 'Away' : st.state;
          const picture = st.attributes?.entity_picture;
          return html`
            <button class="person ${where}" title="${name}: ${whereText}" aria-label="${name}: ${whereText}"
              @click="${(e: Event) => { e.stopPropagation(); moreInfo(entry.entity); }}">
              ${picture
                ? html`<img src="${picture}" alt="" loading="lazy" />`
                : html`<span class="initials">${this._initials(name)}</span>`}
              <span class="dot"></span>
            </button>
          `;
        })}
      </div>
    `;
  }

  static get styles() {
    return css`
      :host {
        display: block;
      }

      .people {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .people.overlap {
        gap: 0;
      }

      .people.overlap .person + .person {
        margin-left: -8px;
      }

      .person {
        position: relative;
        width: 36px;
        height: 36px;
        padding: 2px;
        border: none;
        border-radius: 50%;
        background: none;
        cursor: pointer;
        flex-shrink: 0;
      }

      .person img,
      .person .initials {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        object-fit: cover;
        display: block;
        box-shadow: 0 0 0 2px var(--sidebar-background, #0d1a30);
      }

      .person .initials {
        display: grid;
        place-items: center;
        font-size: 12px;
        font-weight: 600;
        color: var(--sidebar-text-color, #fff);
        background: rgba(255, 255, 255, 0.14);
      }

      /* away: dim the avatar so "who's home" reads at a glance */
      .person.away img,
      .person.away .initials {
        opacity: 0.5;
        filter: grayscale(1);
      }

      /* compact: fits beside the weather icon and temperature */
      :host([compact]) .person {
        width: 34px;
        height: 34px;
      }

      :host([compact]) .person img,
      :host([compact]) .person .initials {
        width: 30px;
        height: 30px;
      }

      :host([compact]) .people.overlap .person + .person {
        margin-left: -6px;
      }

      .dot {
        position: absolute;
        right: 1px;
        bottom: 1px;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #64748b;
        box-shadow: 0 0 0 2px var(--sidebar-background, #0d1a30);
      }

      .person.home .dot {
        background: #22c55e;
      }

      .person.zone .dot {
        background: #3b82f6;
      }
    `;
  }
}

customElements.define('sidebar-presence', PresenceElement);

// ##########################################################################################
// ###   Trends - swipeable time charts (one page per metric)
// ##########################################################################################

interface TrendBand {
  max: number;
  label: string;
  short?: string;
  color: string;
}

interface TrendSeriesConfig {
  entity: string;
  name?: string;
}

interface TrendItemConfig {
  name?: string;
  entity?: string;
  entities?: (string | TrendSeriesConfig)[];
  bands?: 'aqi' | TrendBand[];
  min?: number;
  max?: number;
}

interface TrendsConfig {
  ranges?: string[];
  autoAdvance?: number;
  items?: TrendItemConfig[];
}

interface TrendPoint {
  t: number;
  v: number;
}

// EPA AQI categories
const TREND_AQI_BANDS: TrendBand[] = [
  { max: 50, label: 'Good', color: '#0ca30c' },
  { max: 100, label: 'Moderate', color: '#fab219' },
  { max: 150, label: 'Unhealthy for sensitive groups', short: 'Sensitive', color: '#ec835a' },
  { max: 300, label: 'Unhealthy', color: '#d03b3b' },
  { max: 500, label: 'Hazardous', color: '#9d2b2b' }
];

// Categorical slots validated together on the dark card surface (#18263f).
// Lines cap at three series; a single series with bands uses neutral ink so
// only the bands carry status colour.
const TREND_SERIES_COLORS = ['#3987e5', '#d95926', '#199e70'];
const TREND_NEUTRAL_LINE = '#c9d4e3';
const TREND_MAX_SERIES = 3;
const TREND_MAX_POINTS = 240; // per series, after bucketing
const TREND_HOLD_MS = 250; // press-and-hold before scrubbing on touch
const TREND_SWIPE_SLOP = 8;
const TREND_AUTO_PAUSE_MS = 60000;

function parseTrendRange(range: string): number {
  const m = /^(\d+)\s*([hd])$/i.exec((range || '').trim());
  if (!m) return 24 * 3600000;
  return parseInt(m[1], 10) * (m[2].toLowerCase() === 'd' ? 24 : 1) * 3600000;
}

// Average points into fixed time buckets so a 7-day window stays light.
function bucketTrend(points: TrendPoint[], start: number, end: number, buckets: number): TrendPoint[] {
  if (points.length <= buckets) return points;
  const size = (end - start) / buckets;
  const sums = new Array(buckets).fill(0);
  const counts = new Array(buckets).fill(0);
  points.forEach(p => {
    const i = Math.min(buckets - 1, Math.max(0, Math.floor((p.t - start) / size)));
    sums[i] += p.v;
    counts[i] += 1;
  });
  const out: TrendPoint[] = [];
  for (let i = 0; i < buckets; i++) {
    if (counts[i]) out.push({ t: start + (i + 0.5) * size, v: sums[i] / counts[i] });
  }
  // keep the true latest reading as the last point
  const last = points[points.length - 1];
  if (out.length && last.t > out[out.length - 1].t) out.push(last);
  return out;
}

class TrendsElement extends LitElement {
  hass: any;
  config: TrendsConfig | null = null;
  compact = false;

  private _page = 0;
  private _rangeIndex = 0;
  private _data: Map<string, TrendPoint[]> = new Map();
  private _scrub: { page: number; x: number } | null = null;
  private _dragOffset: number | null = null;

  private _unsubscribe: (() => void) | null = null;
  private _subscribing = false;
  private _subscribedKey = '';
  private _gesture: any = null;
  private _autoTimer: number | null = null;
  private _pausedUntil = 0;
  private _attentionObserver: any = null;
  private _sizeObserver: any = null;
  private _clockTimer: number | null = null;
  private _chartWidth = 200;
  private _fullWidth = 200;
  private _compactWidth = 120;

  static get properties() {
    return {
      hass: { type: Object },
      config: { type: Object },
      compact: { type: Boolean, reflect: true },
      _page: { attribute: false },
      _rangeIndex: { attribute: false },
      _scrub: { attribute: false },
      _dragOffset: { attribute: false }
    };
  }

  /* ---------------- config helpers ---------------- */

  private get _items(): TrendItemConfig[] {
    return (this.config?.items || []).filter(item => item && (item.entity || (item.entities && item.entities.length)));
  }

  private get _ranges(): string[] {
    const r = this.config?.ranges;
    return Array.isArray(r) && r.length ? r : ['24h', '7d'];
  }

  private _series(item: TrendItemConfig): TrendSeriesConfig[] {
    const list = item.entities && item.entities.length ? item.entities : [item.entity as string];
    return list
      .map(e => (typeof e === 'string' ? { entity: e } : e))
      .filter(e => e && e.entity)
      .slice(0, TREND_MAX_SERIES);
  }

  private _bands(item: TrendItemConfig): TrendBand[] | null {
    if (item.bands === 'aqi') return TREND_AQI_BANDS;
    if (Array.isArray(item.bands) && item.bands.length) return [...item.bands].sort((a, b) => a.max - b.max);
    return null;
  }

  private _entityIds(): string[] {
    const ids = new Set<string>();
    this._items.forEach(item => this._series(item).forEach(s => ids.add(s.entity)));
    return Array.from(ids);
  }

  /* ---------------- lifecycle ---------------- */

  connectedCallback() {
    super.connectedCallback();
    this._startAuto();
    this._clockTimer = window.setInterval(() => this.requestUpdate(), 60000);
    // compact while the Attention zone has something in it
    window.setTimeout(() => this._watchAttention(), 0);
    // re-measure when the sidebar width changes (it is set from JS after load)
    if ('ResizeObserver' in window) {
      this._sizeObserver = new (window as any).ResizeObserver(() => this.requestUpdate());
      this._sizeObserver.observe(this);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribeHistory();
    if (this._autoTimer) window.clearInterval(this._autoTimer);
    this._autoTimer = null;
    if (this._clockTimer) window.clearInterval(this._clockTimer);
    this._clockTimer = null;
    if (this._attentionObserver) this._attentionObserver.disconnect();
    this._attentionObserver = null;
    if (this._sizeObserver) this._sizeObserver.disconnect();
    this._sizeObserver = null;
  }

  protected updated(changed): void {
    const key = `${this._entityIds().join(',')}|${this._ranges[this._rangeIndex] || ''}`;
    if ((changed.has('hass') || changed.has('config') || changed.has('_rangeIndex')) &&
        this.hass?.connection && key !== this._subscribedKey && !this._subscribing) {
      this._subscribeHistory(key);
    }
    if (changed.has('config')) {
      this._startAuto();
      if (this._page >= this._items.length) this._page = 0;
    }
    // draw at the real pixel width so markers stay round and labels undistorted
    const chart = this.shadowRoot?.querySelector('.page .chart, .page .empty') as HTMLElement | null;
    const w = chart ? chart.clientWidth : 0;
    if (w > 0) {
      if (this.compact) this._compactWidth = w;
      else this._fullWidth = w;
      const want = this.compact ? this._compactWidth : this._fullWidth;
      if (Math.abs(want - this._chartWidth) > 1) {
        this._chartWidth = want;
        this.requestUpdate();
      }
    }
  }

  private _watchAttention(): void {
    const root = this.getRootNode() as any;
    const attention = root && root.querySelector ? root.querySelector('.attention') : null;
    if (!attention || !('ResizeObserver' in window)) return;
    const check = () => {
      const cs = getComputedStyle(attention);
      const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const busy = attention.getBoundingClientRect().height - padding > 4;
      if (busy !== this.compact) this.compact = busy;
    };
    this._attentionObserver = new (window as any).ResizeObserver(check);
    this._attentionObserver.observe(attention);
    check();
  }

  /* ---------------- history ---------------- */

  private _unsubscribeHistory(): void {
    if (this._unsubscribe) {
      try {
        this._unsubscribe();
      } catch (_e) {
        /* connection already closed */
      }
    }
    this._unsubscribe = null;
    this._subscribedKey = '';
  }

  // history/stream sends the window's history first, then each new state as it
  // happens, so the charts stay live without polling.
  private async _subscribeHistory(key: string): Promise<void> {
    const ids = this._entityIds();
    this._unsubscribeHistory();
    this._data = new Map();
    if (!ids.length) return;
    this._subscribing = true;
    const span = parseTrendRange(this._ranges[this._rangeIndex]);
    try {
      this._unsubscribe = await this.hass.connection.subscribeMessage(
        (msg: any) => this._onHistory(msg),
        {
          type: 'history/stream',
          entity_ids: ids,
          start_time: new Date(Date.now() - span).toISOString(),
          minimal_response: true,
          no_attributes: true,
          significant_changes_only: false
        }
      );
      this._subscribedKey = key;
    } catch (err) {
      console.warn('sidebar-card: could not subscribe to history', err);
    } finally {
      this._subscribing = false;
    }
  }

  private _onHistory(msg: any): void {
    const states = msg && msg.states;
    if (!states) return;
    Object.keys(states).forEach(id => {
      const list = this._data.get(id) || [];
      (states[id] || []).forEach((s: any) => {
        const v = parseFloat(s.s !== undefined ? s.s : s.state);
        const ts = s.lu !== undefined ? s.lu * 1000
          : s.lc !== undefined ? s.lc * 1000
          : new Date(s.last_updated || s.last_changed).getTime();
        if (!isNaN(v) && !isNaN(ts)) list.push({ t: ts, v });
      });
      list.sort((a, b) => a.t - b.t);
      this._data.set(id, list);
    });
    this.requestUpdate();
  }

  private _points(entity: string, start: number, end: number): TrendPoint[] {
    const all = (this._data.get(entity) || []).filter(p => p.t >= start);
    // extend the line to "now" with the current state
    const live = parseFloat(this.hass?.states?.[entity]?.state);
    if (!isNaN(live) && (!all.length || all[all.length - 1].t < end - 60000)) all.push({ t: end, v: live });
    return bucketTrend(all, start, end, TREND_MAX_POINTS);
  }

  /* ---------------- paging ---------------- */

  private _go(page: number): void {
    const n = this._items.length;
    this._page = n ? (page + n) % n : 0;
    this._dragOffset = null;
  }

  private _pauseAuto(): void {
    this._pausedUntil = Date.now() + TREND_AUTO_PAUSE_MS;
  }

  private _startAuto(): void {
    if (this._autoTimer) window.clearInterval(this._autoTimer);
    this._autoTimer = null;
    const secs = Number(this.config?.autoAdvance || 0);
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!secs || secs < 3 || reduced) return;
    this._autoTimer = window.setInterval(() => {
      if (Date.now() < this._pausedUntil || this._gesture || this._items.length < 2) return;
      this._go(this._page + 1);
    }, secs * 1000);
  }

  private _setRange(i: number): void {
    this._pauseAuto();
    if (i !== this._rangeIndex) this._rangeIndex = i;
  }

  /* ---------------- gestures: swipe pages, hold to scrub ---------------- */

  private _chartAt(e: PointerEvent): HTMLElement | null {
    return (e.composedPath() as HTMLElement[]).find(n => n && n.classList && n.classList.contains('chart')) || null;
  }

  private _scrubAt(chart: HTMLElement, clientX: number): void {
    const rect = chart.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    this._scrub = { page: Number(chart.dataset.page), x };
  }

  private _onPointerDown(e: PointerEvent): void {
    if ((e.composedPath() as HTMLElement[]).some(n => n && n.classList && n.classList.contains('dots'))) return;
    this._pauseAuto();
    const track = e.currentTarget as HTMLElement;
    try {
      track.setPointerCapture(e.pointerId);
    } catch (_e) {
      /* pointer already gone */
    }
    const chart = this._chartAt(e);
    this._gesture = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), mode: 'pending', chart, width: track.clientWidth };
    if (chart && e.pointerType !== 'mouse' && !this.compact) {
      this._gesture.hold = window.setTimeout(() => {
        if (this._gesture && this._gesture.mode === 'pending') {
          this._gesture.mode = 'scrub';
          this._scrubAt(chart, this._gesture.x0);
        }
      }, TREND_HOLD_MS);
    }
  }

  private _onPointerMove(e: PointerEvent): void {
    const g = this._gesture;
    if (!g) {
      // mouse hover reads values directly
      if (e.pointerType === 'mouse' && !this.compact) {
        const chart = this._chartAt(e);
        if (chart) this._scrubAt(chart, e.clientX);
        else if (this._scrub) this._scrub = null;
      }
      return;
    }
    if (e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (g.mode === 'pending' && Math.abs(dx) > TREND_SWIPE_SLOP && Math.abs(dx) > Math.abs(dy)) {
      g.mode = 'swipe';
      window.clearTimeout(g.hold);
      this._scrub = null;
    }
    if (g.mode === 'swipe') {
      const atEdge = (this._page === 0 && dx > 0) || (this._page === this._items.length - 1 && dx < 0);
      this._dragOffset = atEdge ? dx * 0.3 : dx;
    } else if (g.mode === 'scrub' && g.chart) {
      this._scrubAt(g.chart, e.clientX);
    }
  }

  private _onPointerUp(e: PointerEvent): void {
    const g = this._gesture;
    if (!g || e.pointerId !== g.id) return;
    window.clearTimeout(g.hold);
    if (g.mode === 'swipe') {
      const dx = e.clientX - g.x0;
      const velocity = dx / Math.max(1, performance.now() - g.t0);
      const flick = Math.abs(velocity) > 0.35;
      const far = Math.abs(dx) > g.width * 0.25;
      const next = this._page + (dx < 0 ? 1 : -1);
      if ((flick || far) && next >= 0 && next < this._items.length) this._go(next);
      else this._dragOffset = null;
    } else if (g.mode === 'scrub' || e.pointerType !== 'mouse') {
      this._scrub = null;
    }
    this._gesture = null;
  }

  private _onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'ArrowRight') {
      this._pauseAuto();
      this._go(this._page + 1);
    } else if (e.key === 'ArrowLeft') {
      this._pauseAuto();
      this._go(this._page - 1);
    }
  }

  /* ---------------- formatting ---------------- */

  private _unit(entity: string): string {
    return this.hass?.states?.[entity]?.attributes?.unit_of_measurement || '';
  }

  private _fmt(v: number, entity: string, precise = false): string {
    if (v === undefined || v === null || isNaN(v)) return '–';
    const unit = this._unit(entity);
    if (unit.indexOf('°') === 0) return `${precise ? v.toFixed(1) : Math.round(v)}°`;
    const digits = precise && Math.abs(v) < 100 ? 1 : 0;
    const n = v.toFixed(digits);
    return unit && unit.toLowerCase() !== 'aqi' ? `${n} ${unit}` : n;
  }

  private _time(t: number, spanMs: number): string {
    return new Date(t).toLocaleString(this.hass?.language || undefined,
      spanMs <= 36 * 3600000 ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric' });
  }

  private _band(bands: TrendBand[], v: number): TrendBand {
    return bands.find(b => v <= b.max) || bands[bands.length - 1];
  }

  /* ---------------- rendering ---------------- */

  private _renderChart(item: TrendItemConfig, pageIndex: number, start: number, end: number, spanMs: number) {
    const series = this._series(item);
    const bands = this._bands(item);
    const lines = series.map((s, i) => ({
      ...s,
      color: series.length === 1 && bands ? TREND_NEUTRAL_LINE : TREND_SERIES_COLORS[i],
      points: this._points(s.entity, start, end),
      label: s.name || this.hass?.states?.[s.entity]?.attributes?.friendly_name || s.entity
    }));
    const values = lines.reduce((acc, l) => acc.concat(l.points.map(p => p.v)), [] as number[]);
    if (!values.length) return html`<div class="empty">No history yet</div>`;

    const W = Math.max(60, Math.round(this.compact ? this._compactWidth : this._fullWidth));
    const H = this.compact ? 26 : 64;
    const padT = this.compact ? 3 : 6;
    const padB = this.compact ? 3 : 4;
    let lo = item.min !== undefined ? item.min : Math.min(...values);
    let hi = item.max !== undefined ? item.max : Math.max(...values);
    if (bands) {
      lo = item.min !== undefined ? item.min : 0;
      // always show the first two bands, and grow to fit the data
      const peakValue = Math.max(...values);
      hi = item.max !== undefined ? item.max : Math.max(peakValue * 1.1, bands.length > 1 ? bands[1].max + 10 : peakValue * 1.1);
    } else if (item.min === undefined && item.max === undefined) {
      const pad = (hi - lo || 1) * 0.12;
      lo -= pad;
      hi += pad;
    }
    const x = (t: number) => ((t - start) / (end - start)) * (W - 6);
    const y = (v: number) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);

    const bandShapes: any[] = [];
    if (bands && !this.compact) {
      let prev = lo;
      for (const b of bands) {
        const top = Math.min(b.max, hi);
        if (top > prev) {
          bandShapes.push(svg`<rect x="0" width="${W - 6}" y="${y(top)}" height="${Math.max(0, y(prev) - y(top))}" fill="${b.color}" fill-opacity="0.09"></rect>`);
          if (b.max < hi) {
            bandShapes.push(svg`<line x1="0" x2="${W - 6}" y1="${y(b.max)}" y2="${y(b.max)}" stroke="${b.color}" stroke-opacity="0.35" stroke-dasharray="2 3"></line>`);
            bandShapes.push(svg`<text x="${W - 8}" y="${y(b.max) - 3}" text-anchor="end" class="band-label">${b.max}</text>`);
          }
        }
        prev = top;
        if (top >= hi) break;
      }
    }

    const scrub = this._scrub && this._scrub.page === pageIndex && !this.compact ? this._scrub : null;
    let tip = html``;
    let cross = svg``;
    if (scrub && lines[0].points.length) {
      const t = start + scrub.x * (end - start);
      const nearest = (pts: TrendPoint[]) => pts.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
      const at = lines.map(l => (l.points.length ? nearest(l.points) : null));
      const X = x(at[0] ? at[0].t : t);
      cross = svg`
        <line class="hair" x1="${X}" x2="${X}" y1="0" y2="${H}"></line>
        ${at.map((p, i) => (p ? svg`<circle cx="${x(p.t)}" cy="${y(p.v)}" r="4" fill="${lines[i].color}" stroke="var(--trend-surface)" stroke-width="2"></circle>` : svg``))}
      `;
      const leftPct = Math.max(22, Math.min(78, (X / (W - 6)) * 100));
      tip = html`
        <div class="tip" style="left: ${leftPct}%">
          <div class="when">${this._time(at[0] ? at[0].t : t, spanMs)}</div>
          ${at.map((p, i) => (p ? html`
            <div class="tip-row"><i style="background: ${lines[i].color}"></i>
              ${lines.length > 1 ? `${lines[i].label} ` : ''}${this._fmt(p.v, lines[i].entity, true)}${bands && lines.length === 1 ? ` · ${this._band(bands, p.v).short || this._band(bands, p.v).label}` : ''}
            </div>` : ''))}
        </div>
      `;
    }

    return html`
      <div class="chart" data-page="${pageIndex}">
        <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
          aria-label="${item.name || lines[0].label}, last ${this._ranges[this._rangeIndex]}">
          ${bandShapes}
          ${bands || this.compact ? svg`` : svg`<line x1="0" x2="${W - 6}" y1="${H / 2}" y2="${H / 2}" class="grid"></line>`}
          ${lines.map(l => {
            if (!l.points.length) return svg``;
            const d = l.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
            const last = l.points[l.points.length - 1];
            return svg`
              <path d="${d}" fill="none" stroke="${l.color}" stroke-width="${this.compact ? 1.75 : 2}"
                stroke-linejoin="round" stroke-linecap="round"></path>
              <circle cx="${x(last.t)}" cy="${y(last.v)}" r="${this.compact ? 3 : 4}" fill="${l.color}"
                stroke="var(--trend-surface)" stroke-width="2"></circle>
            `;
          })}
          ${cross}
        </svg>
        ${tip}
      </div>
    `;
  }

  private _renderPage(item: TrendItemConfig, index: number, start: number, end: number, spanMs: number) {
    const series = this._series(item);
    const main = series[0];
    const st = this.hass?.states?.[main.entity];
    const now = parseFloat(st?.state);
    const bands = this._bands(item);
    const name = item.name || st?.attributes?.friendly_name || main.entity;
    const pts = this._points(main.entity, start, end);
    const vals = pts.map(p => p.v);
    const hi = vals.length ? Math.max(...vals) : NaN;
    const lo = vals.length ? Math.min(...vals) : NaN;
    const band = bands && !isNaN(now) ? this._band(bands, now) : null;
    const peak = bands && pts.length ? pts.reduce((a, b) => (b.v > a.v ? b : a)) : null;

    return html`
      <div class="page" role="tabpanel" aria-hidden="${index !== this._page ? 'true' : 'false'}" aria-label="${name}">
        <div class="head">
          <div>
            <div class="name">${name}</div>
            <div class="value">${this._fmt(now, main.entity)}</div>
          </div>
          ${this.compact
            ? ''
            : band
              ? html`<span class="status"><i style="background: ${band.color}"></i>${band.short || band.label}</span>`
              : html`<span class="sub">H ${this._fmt(hi, main.entity)} · L ${this._fmt(lo, main.entity)}</span>`}
        </div>
        ${this.compact
          ? ''
          : series.length > 1
            ? html`<div class="sub keys">${series.map((s, i) => html`
                <span class="key"><i style="background: ${TREND_SERIES_COLORS[i]}"></i>${s.name || this.hass?.states?.[s.entity]?.attributes?.friendly_name || s.entity}${i > 0 ? ` ${this._fmt(parseFloat(this.hass?.states?.[s.entity]?.state), s.entity)}` : ''}</span>`)}
              </div>`
            : peak
              ? html`<div class="sub">Peak ${this._fmt(peak.v, main.entity)} at ${this._time(peak.t, spanMs)}</div>`
              : ''}
        ${this._renderChart(item, index, start, end, spanMs)}
        ${this.compact ? '' : html`<div class="axis"><span>${this._ranges[this._rangeIndex]} ago</span><span>now</span></div>`}
      </div>
    `;
  }

  protected render() {
    const items = this._items;
    if (!this.hass || !items.length) return html``;
    const ranges = this._ranges;
    const spanMs = parseTrendRange(ranges[this._rangeIndex]);
    const end = Date.now();
    const start = end - spanMs;
    const offset = this._dragOffset !== null ? `calc(${-this._page * 100}% + ${this._dragOffset}px)` : `${-this._page * 100}%`;

    return html`
      <section class="trends" aria-label="Trends">
        <div class="trends-head">
          <span class="label">Trends</span>
          ${ranges.length > 1
            ? html`
                <div class="range" role="group" aria-label="Time range">
                  ${ranges.map((r, i) => html`
                    <button aria-pressed="${i === this._rangeIndex ? 'true' : 'false'}" @click="${() => this._setRange(i)}">${r}</button>`)}
                </div>
              `
            : ''}
        </div>
        <div class="tile" role="region" aria-roledescription="carousel" aria-label="Trends" tabindex="0"
          @keydown="${this._onKeyDown}">
          <div class="track ${this._dragOffset !== null ? 'dragging' : ''}" style="transform: translateX(${offset})"
            @pointerdown="${this._onPointerDown}" @pointermove="${this._onPointerMove}"
            @pointerup="${this._onPointerUp}" @pointercancel="${this._onPointerUp}"
            @pointerleave="${(e: PointerEvent) => { if (e.pointerType === 'mouse' && !this._gesture) this._scrub = null; }}">
            ${items.map((item, i) => this._renderPage(item, i, start, end, spanMs))}
          </div>
          ${items.length > 1
            ? html`
                <div class="dots" role="tablist">
                  ${items.map((item, i) => html`
                    <button role="tab" aria-label="${item.name || this._series(item)[0].entity}"
                      aria-selected="${i === this._page ? 'true' : 'false'}"
                      @click="${() => { this._pauseAuto(); this._go(i); }}"></button>`)}
                </div>
              `
            : ''}
        </div>
      </section>
    `;
  }

  static get styles() {
    return css`
      :host {
        display: block;
        --trend-surface: var(--sidebar-notification-background, #18263f);
        --trend-text: var(--sidebar-text-color, #f1f5f9);
        --trend-text-2: rgba(241, 245, 249, 0.72);
        --trend-text-3: rgba(241, 245, 249, 0.5);
        --trend-border: rgba(255, 255, 255, 0.08);
      }

      .trends {
        margin-top: 18px;
      }

      .trends-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin: 0 2px 8px;
      }

      .label {
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--trend-text-3);
      }

      .range {
        display: flex;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 8px;
        padding: 2px;
      }

      .range button {
        border: none;
        background: none;
        color: var(--trend-text-2);
        font: inherit;
        font-size: 12px;
        font-weight: 500;
        padding: 6px 10px;
        min-height: 28px;
        border-radius: 6px;
        cursor: pointer;
      }

      .range button[aria-pressed='true'] {
        background: rgba(255, 255, 255, 0.12);
        color: var(--trend-text);
      }

      .tile {
        position: relative;
        overflow: hidden;
        background: var(--trend-surface);
        border: 1px solid var(--trend-border);
        border-radius: 14px;
        outline: none;
        color: var(--trend-text);
      }

      .tile:focus-visible {
        box-shadow: 0 0 0 2px #3b82f6;
      }

      .track {
        display: flex;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        transition: transform 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
      }

      .track.dragging {
        transition: none;
      }

      .page {
        flex: 0 0 100%;
        min-width: 0;
        box-sizing: border-box;
        padding: 12px 12px 10px;
      }

      .head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
      }

      .name {
        font-size: 12px;
        color: var(--trend-text-3);
      }

      .value {
        font-size: 26px;
        font-weight: 600;
        line-height: 1.1;
        margin-top: 2px;
      }

      .sub {
        font-size: 12px;
        color: var(--trend-text-2);
        margin-top: 2px;
      }

      .keys {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .key,
      .status {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }

      .key i {
        width: 10px;
        height: 2px;
        border-radius: 1px;
        display: inline-block;
      }

      .status {
        font-size: 12px;
        font-weight: 600;
      }

      .status i {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        display: inline-block;
      }

      .chart {
        position: relative;
        margin-top: 8px;
      }

      .chart svg {
        display: block;
        max-width: 100%;
        overflow: visible;
      }

      .grid {
        stroke: rgba(255, 255, 255, 0.07);
      }

      .hair {
        stroke: var(--trend-text-3);
        stroke-width: 1;
      }

      .band-label {
        font-size: 10px;
        fill: var(--trend-text-3);
      }

      .empty {
        margin-top: 8px;
        height: 64px;
        display: grid;
        place-items: center;
        font-size: 12px;
        color: var(--trend-text-3);
      }

      .axis {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: var(--trend-text-3);
        margin-top: 2px;
        font-variant-numeric: tabular-nums;
      }

      .tip {
        position: absolute;
        top: -6px;
        transform: translate(-50%, -100%);
        background: #0b1424;
        border: 1px solid var(--trend-border);
        border-radius: 8px;
        padding: 6px 8px;
        font-size: 12px;
        white-space: nowrap;
        pointer-events: none;
        box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
        z-index: 2;
      }

      .when {
        color: var(--trend-text-3);
        margin-bottom: 2px;
      }

      .tip-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .tip-row i {
        width: 10px;
        height: 2px;
        border-radius: 1px;
        display: inline-block;
      }

      .dots {
        position: absolute;
        bottom: 6px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        z-index: 3;
      }

      .dots button {
        width: 22px;
        height: 22px;
        border: none;
        background: none;
        padding: 0;
        display: grid;
        place-items: center;
        cursor: pointer;
      }

      .dots button::before {
        content: '';
        width: 6px;
        height: 6px;
        border-radius: 3px;
        background: var(--trend-text-3);
        opacity: 0.5;
        transition: width 0.2s ease, opacity 0.2s ease;
      }

      .dots button[aria-selected='true']::before {
        width: 14px;
        opacity: 1;
        background: var(--trend-text);
      }

      /* ---------- compact: one row while the Attention zone needs room ---------- */
      :host([compact]) .page {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 28px 8px 12px;
      }

      :host([compact]) .head {
        display: block;
        flex: 0 0 auto;
        min-width: 70px;
      }

      :host([compact]) .value {
        font-size: 17px;
      }

      :host([compact]) .chart {
        flex: 1;
        margin-top: 0;
        min-width: 0;
      }

      :host([compact]) .empty {
        height: 26px;
        margin-top: 0;
        flex: 1;
      }

      :host([compact]) .dots {
        top: 50%;
        bottom: auto;
        left: auto;
        right: 4px;
        transform: translateY(-50%);
        flex-direction: column;
      }

      :host([compact]) .dots button {
        width: 20px;
        height: 16px;
      }

      :host([compact]) .dots button[aria-selected='true']::before {
        width: 6px;
        height: 12px;
      }

      @media (prefers-reduced-motion: reduce) {
        .track,
        .dots button::before {
          transition: none;
        }
      }
    `;
  }
}

customElements.define('sidebar-trends', TrendsElement);


const weatherIconUrls = {
  'clear-night': '/local/weather-icons/meteocons/clear-night.svg',
  'cloudy': '/local/weather-icons/meteocons/cloudy.svg',
  'fog': '/local/weather-icons/meteocons/fog.svg',
  'hail': '/local/weather-icons/meteocons/hail.svg',
  'lightning': '/local/weather-icons/meteocons/thunderstorms.svg',
  'lightning-rainy': '/local/weather-icons/meteocons/thunderstorms.svg',
  'partlycloudy': '/local/weather-icons/meteocons/partly-cloudy-day.svg',
  'pouring': '/local/weather-icons/meteocons/rain.svg',
  'rainy': '/local/weather-icons/meteocons/rain.svg',
  'snowy': '/local/weather-icons/meteocons/snow.svg',
  'snowy-rainy': '/local/weather-icons/meteocons/sleet.svg',
  'sunny': '/local/weather-icons/meteocons/clear-day.svg',
  'windy': '/local/weather-icons/meteocons/wind.svg',
  'windy-variant': '/local/weather-icons/meteocons/wind.svg',
  'exceptional': '/local/weather-icons/meteocons/cloudy.svg'
};


// ##########################################################################################
// ###   The actual Sidebar Card element
// ##########################################################################################

class SidebarCard extends LitElement {
  /* **************************************** *
   *        Element's local properties        *
   * **************************************** */

  config: any;
  hass: any;
  shadowRoot: any;
  renderCard: any;
  templateLines: any = [];
  clock = false;
  updateMenu = true;
  digitalClock = false;
  twelveHourVersion = false;
  digitalClockWithSeconds = false;
  period = false;
  date = false;
  dateFormat = 'DD MMMM';
  weather = false;
  weatherEntity = '';
  weatherFormat = 'temperature_unit';
  bottomCard: any = null;
  widgetCard: any = null;
  CUSTOM_TYPE_PREFIX = 'custom:';
  notifications = false; // Add this line
  glanceBar: GlanceItem[] | null = null;
  glancePosition: GlancePosition = 'bottom';
  presence: (string | PresenceEntry)[] = [];
  trends: TrendsConfig | null = null;
  private _resizeObserver: any = null;

  // Markus:
  // Stores the setInterval handle for the periodic clock update
  // Stores the setInterval handle for the periodic date update
  // Stores the bound event handler function for the 'location-changed' event, used to update the active menu item with the correct `this` context
  _clockInterval: any = null;
  _dateInterval: any = null;
  _weatherInterval: any = null;
  _boundLocationChange: any;

  /* **************************************** *
   *        Element's public properties       *
   * **************************************** */

  static get properties() {
    return {
      hass: {},
      config: {},
      active: {},
    };
  }

  /* **************************************** *
   *           Element constructor            *
   * **************************************** */

  //Markus:
  // Binds the location change handler to update the active menu item with a short delay
  constructor() {
    super();
    this._boundLocationChange = () => {
        setTimeout(() => this._updateActiveMenu(), 50);
    };
  }  
  
  connectedCallback() {
      super.connectedCallback();
      // Starts the observer for URL changes
      window.addEventListener('location-changed', this._boundLocationChange);
      
      const self = this;

      // Start timers if they are configured and not already running.
      if ((this.config.clock || this.config.digitalClock) && !this._clockInterval) {
        const inc = 1000;
        // Delay the first run slightly to ensure the DOM is ready.
        setTimeout(() => self._runClock(), 50);
        this._clockInterval = setInterval(function() {
          self._runClock();
        }, inc);
      }
      if (this.config.date && !this._dateInterval) {
        const inc = 1000 * 60 * 60;
        // Delay the first run slightly to ensure the DOM is ready.
        setTimeout(() => self._runDate(), 50);
        this._dateInterval = setInterval(function() {
          self._runDate();
        }, inc);
      }
      if (this.config.weather && !this._weatherInterval) {
        const inc = 1000 * 60 * 5; // Update every 5 minutes
        // Delay the first run slightly to ensure the DOM is ready.
        setTimeout(() => self._runWeather(), 50);
        this._weatherInterval = setInterval(function() {
          self._runWeather();
        }, inc);
      }

      this._updateActiveMenu();
    }


  /* **************************************** *
   *              Card Helpers                *
   * **************************************** */

  async createCard(cardConfig, containerSelector, styleConfig) {
    if (!cardConfig || typeof cardConfig !== 'object' || !cardConfig.type) {
      error2console('createCard', 'Invalid card config!');
      return null;
    }
  
    let tag = cardConfig.type;
    if (tag.startsWith(this.CUSTOM_TYPE_PREFIX)) {
      tag = tag.substr(this.CUSTOM_TYPE_PREFIX.length);
    } else {
      tag = `hui-${tag}-card`;
    }
  
    console.info(`Creating card with tag: ${tag}`);
  
    // Method 2: Create element and verify it has required methods
    const cardElement = document.createElement(tag);
    
    // Wait a bit for the element to fully initialize
    await new Promise(resolve => setTimeout(resolve, 150));
    
    if (!cardElement) {
      error2console('createCard', `Failed to create element: ${tag}`);
      return null;
    }
  
    // Check if it's a proper Home Assistant card
    if (typeof cardElement.setConfig !== 'function') {
      // Try to wait a bit more and check again
      await new Promise(resolve => setTimeout(resolve, 200));
      
      if (typeof cardElement.setConfig !== 'function') {
        console.error(`Element ${tag} is not a valid Home Assistant card (no setConfig method)`);
        return null;
      }
    }
    try {
      // Configure the card
      cardElement.setConfig(cardConfig);
      cardElement.hass = hass();
  
      // Append to container
      const container = this.shadowRoot.querySelector(containerSelector);
      if (container) {
        container.appendChild(cardElement);
        provideHass(cardElement);
  
        // Apply custom styles if provided
        if (styleConfig && styleConfig.cardStyle) {
          this.applyCardStyles(cardElement, styleConfig.cardStyle);
        }
  
        console.info(`Successfully created and configured card: ${tag}`);
        return cardElement;
      } else {
        error2console('createCard', `Container ${containerSelector} not found`);
        return null;
      }
    } catch (error) {
      error2console('createCard', `Error configuring card ${tag}:`, error);
      return null;
    }
  }
  
  applyCardStyles(cardElement, styleString) {
    let iterations = 0;
    const maxIterations = 20; // Increased max iterations
    
    const interval = setInterval(() => {
      if (cardElement && cardElement.shadowRoot) {
        clearInterval(interval);
        const styleElement = document.createElement('style');
        styleElement.innerHTML = styleString;
        cardElement.shadowRoot.appendChild(styleElement);
        console.info('Card styles applied successfully');
      } else if (++iterations >= maxIterations) {
        clearInterval(interval);
        console.warn('Failed to apply card styles - shadowRoot not available');
      }
    }, 100);
  }

  /* **************************************** *
   *   Element's HTML renderer (lit-element)  *
   * **************************************** */

  render() {
    const sidebarMenu = this.config.sidebarMenu;
    const title = 'title' in this.config ? this.config.title : false;
    const addStyle = 'style' in this.config;

    this.clock = this.config.clock ? this.config.clock : false;
    this.digitalClock = this.config.digitalClock ? this.config.digitalClock : false;
    this.digitalClockWithSeconds = this.config.digitalClockWithSeconds ? this.config.digitalClockWithSeconds : false;
    this.twelveHourVersion = this.config.twelveHourVersion ? this.config.twelveHourVersion : false;
    this.period = this.config.period ? this.config.period : false;
    this.date = this.config.date ? this.config.date : false;
    this.dateFormat = this.config.dateFormat ? this.config.dateFormat : 'DD MMMM';
    this.weather = this.config.weather ? this.config.weather : false;
    this.weatherEntity = this.config.weatherEntity ? this.config.weatherEntity : '';
    this.weatherFormat = this.config.weatherFormat ? this.config.weatherFormat : 'temperature_unit';
    this.widgetCard = this.config.widgetCard ? this.config.widgetCard : null;
    this.bottomCard = this.config.bottomCard ? this.config.bottomCard : null;
    this.updateMenu = this.config.hasOwnProperty('updateMenu') ? this.config.updateMenu : true;
    this.notifications = this.config.notifications ? this.config.notifications : false;
    const glance = normalizeGlanceBar(this.config.glanceBar);
    this.glanceBar = glance.items.length ? glance.items : null;
    this.glancePosition = glance.position;
    this.presence = Array.isArray(this.config.presence) ? this.config.presence : [];
    const showPresence = this.presence.length > 0;
    const glanceInAttention = !!this.glanceBar && this.glancePosition === 'attention';
    this.trends = this.config.trends && Array.isArray(this.config.trends.items) && this.config.trends.items.length
      ? this.config.trends
      : null;

    return html`
      ${addStyle
        ? html`
            <style>
              ${this.config.style}
            </style>
          `
        : html``}

      <div class="sidebar-inner">
        ${this.digitalClock
          ? html`
              <h1 class="digitalClock${title ? ' with-title' : ''}${this.digitalClockWithSeconds ? ' with-seconds' : ''}"></h1>
            `
          : html``}
        ${this.clock
          ? html`
              <div class="clock">
                <div class="wrap">
                  <span class="hour"></span>
                  <span class="minute"></span>
                  <span class="second"></span>
                  <span class="dot"></span>
                </div>
              </div>
            `
          : html``}
        ${title
          ? html`
              <h1 class="title">${title}</h1>
            `
          : html``}
        ${this.date
          ? html`
              <h2 class="date"></h2>
            `
          : html``}
        ${this.weather && this.weatherEntity
          ? html`
              <div class="weather-widget${showPresence ? ' with-presence' : ''}">
                <div class="weather-icon">
                  <i class="meteo-icon"></i>
                </div>
                <div class="weather-info">
                  <span class="weather-temp"></span>
                  <span class="weather-desc"></span>
                </div>
                ${showPresence
                  ? html`<sidebar-presence class="in-weather" compact .hass=${this.hass} .entities=${this.presence}></sidebar-presence>`
                  : html``}
              </div>
            `
          : showPresence
            ? html`<sidebar-presence class="standalone" .hass=${this.hass} .entities=${this.presence}></sidebar-presence>`
            : html``}
        ${sidebarMenu && sidebarMenu.length > 0
          ? html`
              <ul class="sidebarMenu">
                ${(sidebarMenu || []).filter(item => this._evaluateVisibleCondition(item.conditional, this.hass)).map((sidebarMenuItem) => {
                  return html`
                    <li @click="${(e) => this._menuAction(e)}" class="${sidebarMenuItem.state && this.hass.states[sidebarMenuItem.state].state != 'off' && this.hass.states[sidebarMenuItem.state].state != 'unavailable' ? 'active' : ''}" data-type="${sidebarMenuItem.action}" data-path="${sidebarMenuItem.navigation_path ? sidebarMenuItem.navigation_path : ''}" data-menuitem="${JSON.stringify(sidebarMenuItem)}">
                      <span>${sidebarMenuItem.name}</span>
                      ${sidebarMenuItem.icon
                          ? html`
                            <ha-icon @click="${(e) => this._menuAction(e)}" icon="${sidebarMenuItem.icon}"></ha-icon>
                          `
                          : html``}
                    </li>
                  `;
                })}

              </ul>
            `
          : html``}
        ${this.trends
          ? html`<sidebar-trends .hass=${this.hass} .config=${this.trends}></sidebar-trends>`
          : html``}
        ${this.widgetCard
          ? html`
              <div class="widget-card"></div>
            `
          : html``}
        ${this.config.template
          ? html`
              <ul class="template">
                ${this.templateLines.map((line) => {
                  return html`
                    ${createElementFromHTML(line)}
                  `;
                })}
              </ul>
            `
          : html``}
        ${this.notifications || glanceInAttention
          ? html`
              <div class="attention">
                ${glanceInAttention
                  ? html`<glance-bar-element mode="alerts" .hass=${this.hass} .items=${this.glanceBar}></glance-bar-element>`
                  : html``}
                ${this.notifications
                  ? html`<notifications-element .hass=${this.hass}></notifications-element>`
                  : html``}
              </div>
            `
          : html``}
        ${this.bottomCard
          ? html`
              <div class="bottom"></div>
            `
          : html``}
        ${this.glanceBar && !glanceInAttention
          ? html`<glance-bar-element .hass=${this.hass} .items=${this.glanceBar}></glance-bar-element>`
          : html``}
      </div>
    `;
  }

  _runClock() {
    let hoursampm;
    let digitalTime;
    const date = new Date();

    let fullHours = date.getHours().toString();
    const realHours = date.getHours();
    const hours = ((realHours + 11) % 12) + 1;
    const minutes = date.getMinutes();
    const seconds = date.getSeconds();

    const hour = Math.floor((hours * 60 + minutes) / 2);
    const minute = minutes * 6;
    const second = seconds * 6;

    if (this.clock) {
      this.shadowRoot.querySelector('.hour').style.transform = `rotate(${hour}deg)`;
      this.shadowRoot.querySelector('.minute').style.transform = `rotate(${minute}deg)`;
      this.shadowRoot.querySelector('.second').style.transform = `rotate(${second}deg)`;
    }
    if (this.digitalClock && !this.twelveHourVersion) {
      const minutesString = minutes.toString();
      digitalTime = fullHours.length < 2 ? '0' + fullHours + ':' : fullHours + ':';
      if (this.digitalClockWithSeconds) {
        digitalTime += minutesString.length < 2 ? '0' + minutesString + ':' : minutesString + ':';
        const secondsString = seconds.toString();
        digitalTime += secondsString.length < 2 ? '0' + secondsString : secondsString;
      } else {
        digitalTime += minutesString.length < 2 ? '0' + minutesString : minutesString;
      }
      this.shadowRoot.querySelector('.digitalClock').textContent = digitalTime;
    } else if (this.digitalClock && this.twelveHourVersion && !this.period) {
      hoursampm = date.getHours();
      hoursampm = hoursampm % 12;
      hoursampm = hoursampm ? hoursampm : 12;
      fullHours = hoursampm.toString();
      const minutesString = minutes.toString();
      digitalTime = fullHours.length < 2 ? '0' + fullHours + ':' : fullHours + ':';
      if (this.digitalClockWithSeconds) {
        digitalTime += minutesString.length < 2 ? '0' + minutesString + ':' : minutesString + ':';
        const secondsString = seconds.toString();
        digitalTime += secondsString.length < 2 ? '0' + secondsString : secondsString;
      } else {
        digitalTime += minutesString.length < 2 ? '0' + minutesString : minutesString;
      }
      //digitalTime;
      this.shadowRoot.querySelector('.digitalClock').textContent = digitalTime;
    } else if (this.digitalClock && this.twelveHourVersion && this.period) {
      var ampm = realHours >= 12 ? 'pm' : 'am';
      hoursampm = date.getHours();
      hoursampm = hoursampm % 12;
      hoursampm = hoursampm ? hoursampm : 12;
      fullHours = hoursampm.toString();
      const minutesString = minutes.toString();
      digitalTime = fullHours.length < 2 ? '0' + fullHours + ':' : fullHours + ':';
      if (this.digitalClockWithSeconds) {
        digitalTime += minutesString.length < 2 ? '0' + minutesString + ':' : minutesString + ':';
        const secondsString = seconds.toString();
        digitalTime += secondsString.length < 2 ? '0' + secondsString : secondsString;
      } else {
        digitalTime += minutesString.length < 2 ? '0' + minutesString : minutesString;
      }
      digitalTime += ' ' + ampm;
      this.shadowRoot.querySelector('.digitalClock').textContent = digitalTime;
    }
  }

  _runDate() {
    const now = moment();
    now.locale(this.hass.language);
    this.shadowRoot.querySelector('.date').textContent = now.format(this.dateFormat);
  }

  _runWeather() {
    if (!this.weather || !this.weatherEntity || !this.hass.states[this.weatherEntity]) {
      return;
    }
  
    const weatherState = this.hass.states[this.weatherEntity];
    const weatherIcon = this.shadowRoot.querySelector('.meteo-icon');
    const weatherTemp = this.shadowRoot.querySelector('.weather-temp');
    const weatherDesc = this.shadowRoot.querySelector('.weather-desc');

    if (weatherIcon && weatherTemp && weatherDesc) {

    // Get the icon URL
    const iconUrl = weatherIconUrls[weatherState.state] || weatherIconUrls['sunny'];
    
    // Use img tag to display the SVG
    weatherIcon.innerHTML = `<img src="${iconUrl}" alt="${weatherState.state}" class="weather-svg-icon">`;
  
      // Set temperature
      const temp = Math.round(weatherState.attributes.temperature);
      const unit = this.weatherFormat === 'temperature_unit' 
        ? weatherState.attributes.unit_of_measurement || '°C'
        : (this.weatherFormat || '°C');
      weatherTemp.textContent = `${temp}${unit}`;
  
      // Set description  
      weatherDesc.textContent = this._formatWeatherCondition(weatherState.state);
    }
  }

  _formatWeatherCondition(condition) {
    const conditionMapping = {
      'clear-night': 'Clear night',
      'cloudy': 'Cloudy',
      'fog': 'Fog',
      'hail': 'Hail',
      'lightning': 'Lightning',
      'lightning-rainy': 'Storm',
      'partlycloudy': 'Partly cloudy',
      'pouring': 'Pouring',
      'rainy': 'Rainy',
      'snowy': 'Snowy',
      'snowy-rainy': 'Sleet',
      'sunny': 'Sunny',
      'windy': 'Windy',
      'windy-variant': 'Very windy',
      'exceptional': 'Exceptional'
    };

    return conditionMapping[condition] || condition.charAt(0).toUpperCase() + condition.slice(1);
  }

  updateSidebarSize(root) {
    const sidebarInner = this.shadowRoot.querySelector('.sidebar-inner');
    const header = root.shadowRoot.querySelector('ch-header') || root.shadowRoot.querySelector('app-header');
    const offParam = getParameterByName('sidebarOff');
    let headerHeightPx = getHeaderHeightPx();
    
    if (sidebarInner) {
      sidebarInner.style.width = this.offsetWidth + 'px';
      if(this.config.hideTopMenu) {
        sidebarInner.style.height = `${window.innerHeight}px`;
        sidebarInner.style.top = '0px';
      } else {
        sidebarInner.style.height = `calc(${window.innerHeight}px - `+headerHeightPx+`)`;
        sidebarInner.style.top = headerHeightPx;
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    // Stop the timers started in connectedCallback() so a reconnect restarts
    // them instead of leaking duplicates
    window.removeEventListener('location-changed', this._boundLocationChange);
    clearInterval(this._clockInterval);
    clearInterval(this._dateInterval);
    clearInterval(this._weatherInterval);
    this._clockInterval = null;
    this._dateInterval = null;
    this._weatherInterval = null;
  }

  firstUpdated() {
    provideHass(this);
    let root = getRoot();
    if (!root) return;

    // Clock, date and weather timers are started in connectedCallback()
    // so they survive reloads; the active menu item is tracked via the
    // 'location-changed' listener registered there.
    const self = this; // self is needed for the setTimeouts below

    setTimeout(() => {
      self.updateSidebarSize(root);
      self._updateActiveMenu();
    }, 50);
    // The panel is position:fixed with a JS-measured px width, so a single
    // measurement at load can race the injected `#customSidebar { width: % }`
    // stylesheet and pin the panel too wide — its content then spills into the
    // separator until a hard refresh re-rolls the timing. Re-apply the width
    // whenever the column is (re)laid out so it always tracks the real column.
    if ('ResizeObserver' in window) {
      this._resizeObserver = new (window as any).ResizeObserver(() => {
        self.updateSidebarSize(root);
      });
      this._resizeObserver.observe(this);
    } else {
      setTimeout(() => {
        self.updateSidebarSize(root);
      }, 350);
    }
    window.addEventListener(
      'resize',
      function() {
        setTimeout(() => {
          self.updateSidebarSize(root);
        }, 1);
      },
      true
    );

    if (this.widgetCard) {
      setTimeout(async () => {
        const card = Object.assign({ type: this.widgetCard.type }, this.widgetCard.cardOptions);
        await this.createCard(card, '.widget-card', this.widgetCard);
      }, 100);
    }

    if (this.bottomCard) {
      setTimeout(async () => {
        const card = Object.assign({ type: this.bottomCard.type }, this.bottomCard.cardOptions);
        await this.createCard(card, '.bottom', this.bottomCard);
      }, 100);
    }
  }

  _updateActiveMenu() {
    if(this.updateMenu) {
      this.shadowRoot.querySelectorAll('ul.sidebarMenu li[data-type="navigate"]').forEach((menuItem) => {
        menuItem.classList.remove('active');
      });
      let activeEl = this.shadowRoot.querySelector('ul.sidebarMenu li[data-path="' + document.location.pathname + '"]');
      if (activeEl) {
        activeEl.classList.add('active');
      }
    }
  }

  _menuAction(e) {
    if ((e.target.dataset && e.target.dataset.menuitem) || (e.target.parentNode.dataset && e.target.parentNode.dataset.menuitem)) {
      const menuItem = JSON.parse(e.target.dataset.menuitem || e.target.parentNode.dataset.menuitem);
      this._customAction(menuItem);
      // Markus:
      // This line is commented out because the menu update is now triggered by the 'location-changed' event
      //this._updateActiveMenu();
    }
  }

  _evaluateVisibleCondition(template: string | undefined, hass: any): boolean {
    if (!template) return true;

    // Clean outer braces and whitespace
    const cleaned = template.trim().replace(/^{{\s*|\s*}}$/g, "").trim();

    try {
      // --- is_state('entity', 'value') ---
      const matchState = cleaned.match(/is_state\(['"]([^'"]+)['"],\s*['"]([^'"]+)['"]\)/);
      if (matchState) {
        const [_, entityId, expected] = matchState;
        return hass.states[entityId]?.state === expected;
      }

      // --- is_state_attr('entity', 'attr', 'value') ---
      const matchAttr = cleaned.match(
          /is_state_attr\(['"]([^'"]+)['"],\s*['"]([^'"]+)['"],\s*['"]([^'"]+)['"]\)/
      );
      if (matchAttr) {
        const [_, entityId, attr, expected] = matchAttr;
        return hass.states[entityId]?.attributes?.[attr] === expected;
      }

      // --- states['entity_id'] == 'value' ---
      const matchEquals = cleaned.match(/states\[['"]([^'"]+)['"]\]\s*==\s*['"]([^'"]+)['"]/);
      if (matchEquals) {
        const [_, entityId, expected] = matchEquals;
        return hass.states[entityId]?.state === expected;
      }

      // ---  Handle simple comparisons, e.g. "states['sensor.temp'] | int > 20"
      //      Support "| int", "| float" filters and numeric comparisons.
      const numericMatch = cleaned.match(
          /states\[['"]([^'"]+)['"]\]\s*\|\s*(int|float)\s*([<>]=?|==)\s*([\d.]+)/
      );
      if (numericMatch) {
        const [_, entityId, type, operator, thresholdStr] = numericMatch;
        const raw = hass.states[entityId]?.state;
        if (raw === undefined) return false;
        const num = type === "float" ? parseFloat(raw) : parseInt(raw, 10);
        const threshold = parseFloat(thresholdStr);

        switch (operator) {
          case ">": return num > threshold;
          case "<": return num < threshold;
          case ">=": return num >= threshold;
          case "<=": return num <= threshold;
          case "==": return num == threshold;
          default: return false;
        }
      }

      // Fallback: if expression doesn’t match known patterns, log a warning
      console.warn("sidebar-card: could not parse visible template:", cleaned);
      return true;
    } catch (err) {
      console.error("sidebar-card: visible template evaluation error:", err);
      return true; // fail open
    }
  }

  _customAction(tapAction) {
    switch (tapAction.action) {
      case 'more-info':
        if (tapAction.entity || tapAction.camera_image) {
          moreInfo(tapAction.entity ? tapAction.entity : tapAction.camera_image!);
        }
        break;
      case 'navigate':
        if (tapAction.navigation_path) {
          navigate(window, tapAction.navigation_path);
        }
        break;
      case 'url':
        if (tapAction.url_path) {
          window.open(tapAction.url_path);
        }
        break;
      case 'toggle':
        if (tapAction.entity) {
          toggleEntity(this.hass, tapAction.entity!);
          forwardHaptic('success');
        }
        break;
      case 'call-service': {
        if (!tapAction.service) {
          forwardHaptic('failure');
          return;
        }
        const [domain, service] = tapAction.service.split('.', 2);
        this.hass.callService(domain, service, tapAction.service_data);
        forwardHaptic('success');
        break;
      }
      case 'service-js':
        if (tapAction.service) {
          try {
            const code = tapAction.service
            .toString()
            .replace(/^\[\[\[\s*|\s*\]\]\]$/g, '');
            const func = new Function(code);
            func.call(this);
            forwardHaptic('success');;
          } catch (err) {
            forwardHaptic('failure');
          }
        } else {
          error2console('service-js', 'no service code found');
        }
        break;
    }
  }

  setConfig(config) {
    this.config = config;

    if (this.config.template) {
      subscribeRenderTemplate(
        null,
        (res) => {
          const regex = /<(?:li|div)(?:\s+(?:class|id)\s*=\s*"([^"]*)")*\s*>([^<]*)<\/(?:li|div)>/g
          this.templateLines = res.match(regex).map( (val) => val);
          this.requestUpdate();
        },
        {
          template: this.config.template,
          variables: { config: this.config },
          entity_ids: this.config.entity_ids,
        }
      );
    }
  }

  getCardSize() {
    return 1;
  }

  static get styles() {
    return css`
      :host {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        // --face-color: #FFF;
        // --face-border-color: #FFF;
        // --clock-hands-color: #000;
        // --clock-seconds-hand-color: #FF4B3E;
        // --clock-middle-background: #FFF;
        // --clock-middle-border: #000;
        // --sidebar-background: #FFF;
        // --sidebar-text-color: #000;
        // --sidebar-icon-color: #000;
        // --sidebar-selected-text-color: #000;
        // --sidebar-selected-icon-color: #000;
        background-color:  var(--sidebar-background, var(--paper-listbox-background-color, var(--primary-background-color, #fff)));
      }

      .sidebar-inner {
        padding: 24px 20px;
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        position: fixed;
        width: 0;
        overflow: hidden auto;
      }

      .sidebarMenu {
        list-style: none;
        padding: 0;
        border-top: none;
        border-bottom: none;
      }

      .sidebarMenu li {
        color: var(--sidebar-text-color);
        position: relative;
        padding: 14px 16px;
        border-radius: 12px;
        font-size: 15px;
        line-height: 20px;
        font-weight: 500;
        white-space: normal;
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: pointer;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        margin-bottom: 4px;
        background: transparent;
        border: 1px solid transparent;
      }

      .sidebarMenu li:hover {
        background-color: rgba(255, 255, 255, 0.06);
        border-color: var(--sidebar-border-color);
        transform: translateX(2px);
      }

      .sidebarMenu li ha-icon {
        color: var(--sidebar-icon-color);
        --mdc-icon-size: 20px;
        margin-left: auto;
        flex-shrink: 0;
        transition: color 0.3s ease, transform 0.3s ease;
      }

      .sidebarMenu li:hover ha-icon {
        color: var(--sidebar-selected-icon-color);
        transform: scale(1.1);
      }

      .sidebarMenu li.active {
        color: var(--sidebar-selected-text-color);
        background: var(--sidebar-selected-background);
        border-color: rgba(96, 165, 250, 0.3);
        box-shadow: 0 4px 12px rgba(96, 165, 250, 0.15);
        transform: translateX(4px);
      }

      .sidebarMenu li.active::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-color: var(--sidebar-selected-icon-color, #000);
        opacity: 0.12;
        border-radius: 12px;
      }

      .sidebarMenu li.active ha-icon {
        color: var(--sidebar-selected-icon-color);
      }

      .sidebarMenu li span {
        flex: 1;
        margin-right: 12px;
      }

      /* Header Styles */
      h1 {
        margin-top: 15px;
        margin-bottom: 16px;
        font-size: 42px;
        line-height: 48px;
        font-weight: 300;
        color: var(--sidebar-text-color);
        cursor: default;
        letter-spacing: -0.025em;
      }

      h1.digitalClock {
        font-size: 72px;
        line-height: 56px;
        font-weight: 200;
        cursor: default;
        letter-spacing: -0.03em;
        color: #ffffff;
        text-align: center;
      }

      h1.digitalClock.with-seconds {
        font-size: 42px;
        line-height: 48px;
        cursor: default;
      }

      h1.digitalClock.with-title {
        margin-bottom: 8px;
        cursor: default;
      }

      h2 {
        margin: 0 0 20px 0;
        font-size: 16px;
        line-height: 20px;
        font-weight: 400;
        color: var(--sidebar-text-color);
        cursor: default;
        opacity: 0.8;
      }

      h2.date {
        font-size: 24px;
        text-align: center;
        line-height: 32px;
      }

      /* Template Section */
      .template {
        margin: 20px 0;
        padding: 20px;
        list-style: none;
        color: var(--sidebar-text-color);
        background: var(--sidebar-card-background);
        border: 1px solid var(--sidebar-border-color);
        border-radius: 12px;
        backdrop-filter: blur(10px);
      }

      .template li {
        display: block;
        color: inherit;
        font-size: 14px;
        line-height: 20px;
        font-weight: 400;
        white-space: normal;
        margin-bottom: 8px;
      }

      .template li:last-child {
        margin-bottom: 0;
      }

      /* Weather Widget */
      .weather-widget {
        display: flex;
        align-items: center;
        margin: 0 0 24px 0;
        padding: 20px;
        background: var(--sidebar-card-background);
        border: 1px solid var(--sidebar-border-color);
        border-radius: 12px;
        backdrop-filter: blur(10px);
        color: var(--sidebar-text-color);
        cursor: default;
        transition: all 0.3s ease;
      }

      .weather-widget:hover {
        background: rgba(255, 255, 255, 0.08);
        border-color: rgba(96, 165, 250, 0.3);
      }

      .weather-icon {
        margin-right: 16px;
        width: 56px;
        height: 56px;
        display: flex;
        justify-content: center;
        align-items: center;
        background: rgba(96, 165, 250, 0.1);
        border-radius: 10px;
        padding: 8px;
      }

      .meteo-icon {
        width: 40px;
        height: 40px;
        display: flex;
        justify-content: center;
        align-items: center;
      }

      .weather-svg-icon {
        width: 40px !important;
        height: 40px !important;
        object-fit: contain;
        display: block;
        filter: brightness(0) saturate(100%) invert(65%) sepia(78%) saturate(3893%) hue-rotate(200deg) brightness(104%) contrast(97%);
      }

      .weather-info {
        display: flex;
        flex-direction: column;
        flex: 1;
      }

      .weather-temp {
        font-size: 24px;
        font-weight: 500;
        line-height: 28px;
        margin-bottom: 2px;
        color: #ffffff;
      }

      .weather-desc {
        font-size: 14px;
        font-weight: 400;
        opacity: 0.8;
        line-height: 16px;
      }

      /* Clock Styles */
      .clock {
        margin: 20px auto 28px auto;
        position: relative;
        padding-top: 55%;
        width: 55%;
        border-radius: 100%;
        background: rgba(255, 255, 255, 0.08);
        font-family: 'Montserrat', -apple-system, BlinkMacSystemFont, sans-serif;
        border: 2px solid var(--sidebar-border-color);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3), inset 0 2px 8px rgba(0, 0, 0, 0.2);
      }

      .clock .wrap {
        overflow: hidden;
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        border-radius: 100%;
      }

      .clock .minute,
      .clock .hour {
        position: absolute;
        height: 28%;
        width: 3px;
        margin: auto;
        top: -27%;
        left: 0;
        bottom: 0;
        right: 0;
        background: #e1e5e9;
        transform-origin: bottom center;
        transform: rotate(0deg);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
        z-index: 1;
        border-radius: 2px;
      }

      .clock .minute {
        position: absolute;
        height: 38%;
        width: 2px;
        top: -35%;
        left: 0;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
        transform: rotate(90deg);
      }

      .clock .second {
        position: absolute;
        top: -45%;
        height: 45%;
        width: 1px;
        margin: auto;
        left: 0;
        bottom: 0;
        right: 0;
        border-radius: 1px;
        background: #60a5fa;
        transform-origin: bottom center;
        transform: rotate(180deg);
        z-index: 1;
      }

      .clock .dot {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        width: 8px;
        height: 8px;
        border-radius: 100px;
        background: #60a5fa;
        border: 2px solid #1a1a1a;
        margin: auto;
        z-index: 2;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
      }

      /* Notifications Styles */
      .notifications-container {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin: 16px 0;
      }

      .notification-card {
        background: var(--sidebar-card-background);
        border-radius: 12px;
        padding: 16px;
        backdrop-filter: blur(10px);
        border: 1px solid var(--sidebar-border-color);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        transition: all 0.3s ease;
      }

      .notification-card:hover {
        background: rgba(255, 255, 255, 0.08);
        border-color: rgba(96, 165, 250, 0.3);
      }

      .no-notifications {
        text-align: center;
        padding: 24px 16px;
      }

      .no-notifications-title {
        color: var(--sidebar-text-color);
        margin: 8px 0 4px 0;
        font-size: 16px;
        font-weight: 500;
      }

      .no-notifications-subtitle {
        color: var(--sidebar-icon-color);
        margin: 0;
        font-size: 14px;
      }

      .notification-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
      }

      .notification-title-row {
        display: flex;
        align-items: center;
        gap: 12px;
        flex: 1;
      }

      .notification-icon {
        width: 20px;
        height: 20px;
        flex-shrink: 0;
      }

      .notification-icon.error {
        color: #ef4444;
      }

      .notification-icon.info {
        color: #60a5fa;
      }

      .notification-icon.success {
        color: #10b981;
      }

      .notification-icon.warning {
        color: #f59e0b;
      }

      .notification-title {
        color: var(--sidebar-text-color);
        margin: 0;
        font-size: 14px;
        font-weight: 500;
        line-height: 1.4;
      }

      .dismiss-icon-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 4px;
        border-radius: 8px;
        transition: background-color 0.2s ease;
        flex-shrink: 0;
      }

      .dismiss-icon-btn:hover {
        background: rgba(255, 255, 255, 0.1);
      }

      .dismiss-icon-btn svg {
        width: 16px;
        height: 16px;
        color: var(--sidebar-icon-color);
      }

      .dismiss-icon-btn:hover svg {
        color: var(--sidebar-text-color);
      }

      .notification-message {
        color: var(--sidebar-text-color);
        font-size: 14px;
        line-height: 1.5;
        margin-bottom: 12px;
        opacity: 0.9;
      }

      .notification-message .bullet-point {
        margin-left: 16px;
        display: flex;
        align-items: flex-start;
        gap: 8px;
        margin-bottom: 4px;
      }

      .notification-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .notification-time {
        color: var(--sidebar-icon-color);
        font-size: 12px;
      }

      .dismiss-btn {
        background: #60a5fa;
        color: #ffffff;
        border: none;
        padding: 6px 12px;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
      }

      .dismiss-btn:hover {
        background: #3b82f6;
        transform: translateY(-1px);
      }

      .dismiss-all-container {
        text-align: center;
        padding-top: 8px;
      }

      .dismiss-all-btn {
        background: none;
        border: none;
        color: var(--sidebar-icon-color);
        font-size: 14px;
        cursor: pointer;
        transition: color 0.2s ease;
      }

      .dismiss-all-btn:hover {
        color: var(--sidebar-text-color);
      }


      /* Widget Card */
      .widget-card {
        display: flex;
        padding: 15px;
        background: var(--sidebar-card-background);
        border: 1px solid var(--sidebar-border-color);
        border-radius: 12px;
        backdrop-filter: blur(10px);
      }

      /* Presence on the weather row */
      .weather-widget.with-presence {
        padding: 16px;
      }

      .weather-widget.with-presence .weather-icon {
        width: 48px;
        height: 48px;
        margin-right: 12px;
        box-sizing: border-box;
      }

      .weather-widget sidebar-presence.in-weather {
        margin-left: auto;
        padding-left: 8px;
        flex-shrink: 0;
      }

      sidebar-presence.standalone {
        margin: 0 0 24px 0;
      }

      /* Attention zone: live alerts + notifications. Anchored to the bottom so
         it grows upward and the clock and menu above never move. It has no
         position of its own: the notification panel must resolve against
         .sidebar-inner. */
      .attention {
        margin-top: auto;
        padding-top: 16px;
        padding-bottom: 8px;
      }

      .attention ~ .bottom {
        margin-top: 12px;
      }

      .attention ~ glance-bar-element {
        margin-top: 0;
      }

      /* Bottom Card */
      .bottom {
        display: flex;
        margin-top: auto;
        padding: 15px;
        background: var(--sidebar-card-background);
        border: 1px solid var(--sidebar-border-color);
        border-radius: 12px;
        backdrop-filter: blur(10px);
      }

      /* Scrollbar styling */
      ::-webkit-scrollbar {
        width: 6px;
      }

      ::-webkit-scrollbar-track {
        background: rgba(255, 255, 255, 0.05);
        border-radius: 3px;
      }

      ::-webkit-scrollbar-thumb {
        background: rgba(96, 165, 250, 0.3);
        border-radius: 3px;
      }

      ::-webkit-scrollbar-thumb:hover {
        background: rgba(96, 165, 250, 0.5);
      }
    `;
  }
}

customElements.define('sidebar-card', SidebarCard);

// ##########################################################################################
// ###   The default CSS of the Sidebar Card element
// ##########################################################################################

function createCSS(sidebarConfig: any, width: number) {
  let sidebarWidth = 25;
  let contentWidth = 75;
  let sidebarResponsive = false;
  let headerHeightPx = getHeaderHeightPx();
  if (sidebarConfig.width) {
    if (typeof sidebarConfig.width == 'number') {
      sidebarWidth = sidebarConfig.width;
      contentWidth = 100 - sidebarWidth;
    } else if (typeof sidebarConfig.width == 'object') {
      sidebarWidth = sidebarConfig.desktop;
      contentWidth = 100 - sidebarWidth;
      sidebarResponsive = true;
    }
  }
  // create css
  let css = `
    #customSidebarWrapper { 
      display:flex;
      flex-direction:row;
      overflow:hidden;
    }
    #customSidebar.hide {
      display:none!important;
      width:0!important;
    }
    #view.hideSidebar {
      width:100%!important;
    }
  `;
  if (sidebarResponsive) {
    if (width <= sidebarConfig.breakpoints.mobile) {
      if (sidebarConfig.width.mobile == 0) {
        css +=
          `
          #customSidebar {
            width:` +
          sidebarConfig.width.mobile +
          `%;
            overflow:hidden;
            display:none;
            ${sidebarConfig.hideTopMenu ? '' : 'margin-top: calc('+headerHeightPx+' + env(safe-area-inset-top));'}
          } 
          #view {
            width:` +
          (100 - sidebarConfig.width.mobile) +
          `%;
          ${sidebarConfig.hideTopMenu ? 'padding-top:0!important;margin-top:0!important;' : ''}
          }
        `;
      } else {
        css +=
          `
          #customSidebar {
            width:` +
          sidebarConfig.width.mobile +
          `%;
            overflow:hidden;
            ${sidebarConfig.hideTopMenu ? '' : 'margin-top: calc('+headerHeightPx+' + env(safe-area-inset-top));'}
          } 
          #view {
            width:` +
          (100 - sidebarConfig.width.mobile) +
          `%;
          ${sidebarConfig.hideTopMenu ? 'padding-top:0!important;margin-top:0!important;' : ''}
          }
        `;
      }
    } else if (width <= sidebarConfig.breakpoints.tablet) {
      if (sidebarConfig.width.tablet == 0) {
        css +=
          `
          #customSidebar {
            width:` +
          sidebarConfig.width.tablet +
          `%;
            overflow:hidden;
            display:none;
            ${sidebarConfig.hideTopMenu ? '' : 'margin-top: calc('+headerHeightPx+' + env(safe-area-inset-top));'}
          } 
          #view {
            width:` +
          (100 - sidebarConfig.width.tablet) +
          `%;
          ${sidebarConfig.hideTopMenu ? 'padding-top:0!important;margin-top:0!important;' : ''}
          }
        `;
      } else {
        css +=
          `
          #customSidebar {
            width:` +
          sidebarConfig.width.tablet +
          `%;
            overflow:hidden;
            ${sidebarConfig.hideTopMenu ? '' : 'margin-top: calc('+headerHeightPx+' + env(safe-area-inset-top));'}
          } 
          #view {
            width:` +
          (100 - sidebarConfig.width.tablet) +
          `%;
          ${sidebarConfig.hideTopMenu ? 'padding-top:0!important;margin-top:0!important;' : ''}
          }
        `;
      }
    } else {
      if (sidebarConfig.width.desktop == 0) {
        css +=
          `
          #customSidebar {
            width:` +
          sidebarConfig.width.desktop +
          `%;
            overflow:hidden;
            display:none;
            ${sidebarConfig.hideTopMenu ? '' : 'margin-top: calc('+headerHeightPx+' + env(safe-area-inset-top));'}
          } 
          #view {
            width:` +
          (100 - sidebarConfig.width.desktop) +
          `%;
          ${sidebarConfig.hideTopMenu ? 'padding-top:0!important;margin-top:0!important;' : ''}
          }
        `;
      } else {
        css +=
          `
          #customSidebar {
            width:` +
          sidebarConfig.width.desktop +
          `%;
            overflow:hidden;
            ${sidebarConfig.hideTopMenu ? '' : 'margin-top: calc('+headerHeightPx+' + env(safe-area-inset-top));'}
          } 
          #view {
            width:` +
          (100 - sidebarConfig.width.desktop) +
          `%;
          ${sidebarConfig.hideTopMenu ? 'padding-top:0!important;margin-top:0!important;' : ''}
          }
        `;
      }
    }
  } else {
    css +=
      `
      #customSidebar {
        width:` +
      sidebarWidth +
      `%;
        overflow:hidden;
        ${sidebarConfig.hideTopMenu ? '' : 'margin-top: calc('+headerHeightPx+' + env(safe-area-inset-top));'}
      } 
      #view {
        width:` +
      contentWidth +
      `%;
      ${sidebarConfig.hideTopMenu ? 'padding-top:0!important;margin-top:0!important;' : ''}
      }
    `;
  }
  return css;
}

// ##########################################################################################
// ###   Helper methods
// ##########################################################################################

function getLovelace() {
  let root: any = document.querySelector('home-assistant');
  root = root && root.shadowRoot;
  root = root && root.querySelector('home-assistant-main');
  root = root && root.shadowRoot;
  root = root && root.querySelector('ha-drawer partial-panel-resolver');
  root = root && root.shadowRoot || root;
  root = root && root.querySelector('ha-panel-lovelace');
  root = root && root.shadowRoot;
  root = root && root.querySelector('hui-root');
  if (root) {
      const ll = root.lovelace;
      ll.current_view = root.___curView;
      return ll;
  }
  return null;
}

async function log2console(method: string, message: string, object?: any) {
  const lovelace = await getConfig();
  if (lovelace.config.sidebar) {
    const sidebarConfig = Object.assign({}, lovelace.config.sidebar);
    if (sidebarConfig.debug === true) {
      console.info(`%c${SIDEBAR_CARD_TITLE}: %c ${method.padEnd(24)} -> %c ${message}`, 'color: chartreuse; background: black; font-weight: 700;', 'color: yellow; background: black; font-weight: 700;', '', object);
    }
  }
}

async function error2console(method: string, message: string, object?: any) {
  const lovelace = await getConfig();
  if (lovelace.config.sidebar) {
    const sidebarConfig = Object.assign({}, lovelace.config.sidebar);
    if (sidebarConfig.debug === true) {
      console.error(`%c${SIDEBAR_CARD_TITLE}: %c ${method.padEnd(24)} -> %c ${message}`, 'color: red; background: black; font-weight: 700;', 'color: white; background: black; font-weight: 700;', 'color:red', object);
    }
  }
}

// Returns the root element
function getRoot() {
  let root: any = document.querySelector('home-assistant');
  root = root && root.shadowRoot;
  root = root && root.querySelector('home-assistant-main');
  root = root && root.shadowRoot;
  root = root && root.querySelector('ha-drawer partial-panel-resolver');
  root = (root && root.shadowRoot) || root;
  root = root && root.querySelector('ha-panel-lovelace');
  root = root && root.shadowRoot;
  root = root && root.querySelector('hui-root');

  return root;
}

// return var(--header-height) from #view element
// We need to take from the div#view element in case of "kiosk-mode" module installation that defined new CSS var(--header-height) as local new variable, not available in div#customSidebar
function getHeaderHeightPx() {
	let headerHeightPx = '0px';
	const root = getRoot();
  if (!root || !root.shadowRoot) {
    return headerHeightPx;   // Fallback for Safari LOG entry: (evaluating 'root.shadowRoot')
  }
  const view = root.shadowRoot.getElementById('view');
	//debugger;
	if(view!==undefined && window.getComputedStyle(view)!==undefined) {
		headerHeightPx = window.getComputedStyle(view).paddingTop;
	}
    return headerHeightPx;
}

// Returns the Home Assistant Sidebar element
function getSidebar() {
  let sidebar: any = document.querySelector('home-assistant');
  sidebar = sidebar && sidebar.shadowRoot;
  sidebar = sidebar && sidebar.querySelector('home-assistant-main');
  sidebar = sidebar && sidebar.shadowRoot;
  sidebar = sidebar && sidebar.querySelector('ha-drawer ha-sidebar');

  return sidebar;
}

// Returns the Home Assistant app-drawer layout element
function getAppDrawerLayout() {
  let appDrawerLayout: any = document.querySelector('home-assistant');
  appDrawerLayout = appDrawerLayout && appDrawerLayout.shadowRoot;
  appDrawerLayout = appDrawerLayout && appDrawerLayout.querySelector('home-assistant-main');
  appDrawerLayout = appDrawerLayout && appDrawerLayout.shadowRoot;
  appDrawerLayout = appDrawerLayout && appDrawerLayout.querySelector('ha-drawer'); // ha-drawer
  appDrawerLayout = appDrawerLayout && appDrawerLayout.shadowRoot;
  appDrawerLayout = appDrawerLayout && appDrawerLayout.querySelector('.mdc-drawer-app-content');

  return appDrawerLayout;
}

// Returns the Home Assistant app-drawer element
function getAppDrawer() {
  let appDrawer: any = document.querySelector('home-assistant');
  appDrawer = appDrawer && appDrawer.shadowRoot;
  appDrawer = appDrawer && appDrawer.querySelector('home-assistant-main');
  appDrawer = appDrawer && appDrawer.shadowRoot;
  appDrawer = appDrawer && appDrawer.querySelector('ha-drawer'); // ha-drawer
  appDrawer = appDrawer && appDrawer.shadowRoot;
  appDrawer = appDrawer && appDrawer.querySelector('.mdc-drawer');

  return appDrawer;
}

// Returns a query parameter by its name
function getParameterByName(name: string, url = window.location.href) {
  const parameterName = name.replace(/[\[\]]/g, '\\$&');
  const regex = new RegExp('[?&]' + parameterName + '(=([^&#]*)|&|#|$)');
  const results = regex.exec(url);

  if (!results) return null;
  if (!results[2]) return '';

  return decodeURIComponent(results[2].replace(/\+/g, ' '));
}

// hides (if requested) the HA header, HA footer and/or HA sidebar and hides this sidebar if configured so
function updateStyling(appLayout: any, sidebarConfig: any) {
  const width = document.body.clientWidth;
  appLayout.querySelector('#customSidebarStyle').textContent = createCSS(sidebarConfig, width);

  const root = getRoot();
  const hassHeader = root.shadowRoot.querySelector('.header');
  log2console('updateStyling', hassHeader ? 'Home Assistant header found!' : 'Home Assistant header not found!');
  const hassFooter = root.shadowRoot.querySelector('ch-footer' || root.shadowRoot.querySelector('app-footer'));
  log2console('updateStyling', hassFooter ? 'Home Assistant footer found!' : 'Home Assistant footer not found!');
  const offParam = getParameterByName('sidebarOff');
  const view = root.shadowRoot.getElementById('view');
  let headerHeightPx = getHeaderHeightPx();

  if (sidebarConfig.hideTopMenu && sidebarConfig.hideTopMenu === true && sidebarConfig.showTopMenuOnMobile && sidebarConfig.showTopMenuOnMobile === true && width <= sidebarConfig.breakpoints.mobile && offParam == null) {
    if (hassHeader) {
      log2console('updateStyling', 'Action: Show Home Assistant header!');
      hassHeader.style.display = 'block';
    }
    if (view) {
      view.style.minHeight = 'calc(100vh - '+headerHeightPx+')';
    }
    if (hassFooter) {
      log2console('updateStyling', 'Action: Show Home Assistant footer!');
      hassFooter.style.display = 'flex';
    }
  } else if (sidebarConfig.hideTopMenu && sidebarConfig.hideTopMenu === true && offParam == null) {
    if (hassHeader) {
      log2console('updateStyling', 'Action: Hide Home Assistant header!');
      hassHeader.style.display = 'none';
    }
    if (hassFooter) {
      log2console('updateStyling', 'Action: Hide Home Assistant footer!');
      hassFooter.style.display = 'none';
    }
    if (view) {
      view.style.minHeight = 'calc(100vh)';
    }
  }
}

// watch and handle the resize and location-changed events
function subscribeEvents(appLayout: any, sidebarConfig: any, contentContainer: any, sidebar: any) {
  window.addEventListener(
    'resize',
    function() {
      updateStyling(appLayout, sidebarConfig);
    },
    true
  );

  if ('hideOnPath' in sidebarConfig) {
    window.addEventListener('location-changed', () => {
      if (sidebarConfig.hideOnPath.includes(window.location.pathname)) {
        contentContainer.classList.add('hideSidebar');
        sidebar.classList.add('hide');
      } else {
        contentContainer.classList.remove('hideSidebar');
        sidebar.classList.remove('hide');
      }
    });

    if (sidebarConfig.hideOnPath.includes(window.location.pathname)) {
      log2console('subscribeEvents', 'Disable sidebar for this path');
      contentContainer.classList.add('hideSidebar');
      sidebar.classList.add('hide');
    }
  }
}

function watchLocationChange() {
  setTimeout(() => {
    window.addEventListener('location-changed', () => {
      const root = getRoot();
      if (!root) return; // location changed before finishing dom rendering
      const appLayout = root.shadowRoot.querySelector('div');
      const customSidebarWrapper = appLayout.querySelector('#customSidebarWrapper');
      if (!customSidebarWrapper) {
        buildSidebar();
      } else {
        const customSidebar = customSidebarWrapper.querySelector('#customSidebar');
        if (!customSidebar) {
          buildSidebar();
        }
      }
    });
  }, 1000);
}

// build the custom sidebar card
async function buildCard(sidebar: any, config: any) {
  const sidebarCard = document.createElement('sidebar-card') as SidebarCard;
  sidebarCard.setConfig(config);
  sidebarCard.hass = hass();

  sidebar.appendChild(sidebarCard);
}

// non-blocking sleep function
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// gets the lovelace config
async function getConfig() {
  let lovelace: any;
  while (!lovelace) {
    lovelace = getLovelace();
    if (!lovelace) {
      await sleep(500);
    }
  }

  return lovelace;
}

function createElementFromHTML(htmlString: string) {
  const div = document.createElement('div');
  div.innerHTML = htmlString.trim();
  return div.firstChild;
}




// ##########################################################################################
// ###   The Sidebar Card code base initialisation
// ##########################################################################################

async function buildSidebar() {
  const lovelace = await getConfig();
  if (lovelace.config.sidebar) {
    const sidebarConfig = Object.assign({}, lovelace.config.sidebar);
    if (!sidebarConfig.width || (sidebarConfig.width && typeof sidebarConfig.width == 'number' && sidebarConfig.width > 0 && sidebarConfig.width < 100) || (sidebarConfig.width && typeof sidebarConfig.width == 'object')) {
      const root = getRoot();
      const hassSidebar = getSidebar();
      const appDrawerLayout = getAppDrawerLayout();
      const appDrawer = getAppDrawer();
      const offParam = getParameterByName('sidebarOff');
    
      // SAFETY CHECK: Only continue if root and shadowRoot are valid
      if (!root || !root.shadowRoot) {
        // Prevents crash if Home Assistant UI root or its shadowRoot is not ready
        error2console('buildSidebar', 'Root element or shadowRoot not found!');
        return;
      }

      // Now safe to access shadowRoot
      if (sidebarConfig.hideTopMenu && sidebarConfig.hideTopMenu === true && offParam == null) {
        if (root.shadowRoot.querySelector('ch-header')) root.shadowRoot.querySelector('ch-header').style.display = 'none';
        if (root.shadowRoot.querySelector('app-header')) root.shadowRoot.querySelector('app-header').style.display = 'none';
        if (root.shadowRoot.querySelector('ch-footer')) root.shadowRoot.querySelector('ch-footer').style.display = 'none';
        if (root.shadowRoot.getElementById('view')) root.shadowRoot.getElementById('view').style.minHeight = 'calc(100vh)';
      }

      if (sidebarConfig.hideHassSidebar && sidebarConfig.hideHassSidebar === true && offParam == null) {
        if (hassSidebar) {
          hassSidebar.style.display = 'none';
        }
        if (appDrawerLayout) {
          appDrawerLayout.style.marginLeft = '0';
          appDrawerLayout.style.paddingLeft = '0';
        }
        if (appDrawer) {
          appDrawer.style.display = 'none';
        }
      }
      if (!sidebarConfig.breakpoints) {
        sidebarConfig.breakpoints = {
          tablet: 1024,
          mobile: 768,
        };
      } else if (sidebarConfig.breakpoints) {
        if (!sidebarConfig.breakpoints.mobile) {
          sidebarConfig.breakpoints.mobile = 768;
        }
        if (!sidebarConfig.breakpoints.tablet) {
          sidebarConfig.breakpoints.tablet = 1024;
        }
      }

      let appLayout = root.shadowRoot.querySelector('div');
      let css = createCSS(sidebarConfig, document.body.clientWidth);
      let style: any = document.createElement('style');
      style.setAttribute('id', 'customSidebarStyle');
      appLayout.appendChild(style);
      style.type = 'text/css';
      if (style.styleSheet) {
        // This is required for IE8 and below.
        style.styleSheet.cssText = css;
      } else {
        style.appendChild(document.createTextNode(css));
      }
      // get element to wrap
      let contentContainer = appLayout.querySelector('#view');
      // create wrapper container
      const wrapper = document.createElement('div');
      wrapper.setAttribute('id', 'customSidebarWrapper');
      // insert wrapper before el in the DOM tree
      contentContainer.parentNode.insertBefore(wrapper, contentContainer);
      // move el into wrapper
      let sidebar = document.createElement('div');
      sidebar.setAttribute('id', 'customSidebar');
      wrapper.appendChild(sidebar);
      wrapper.appendChild(contentContainer);
      await buildCard(sidebar, sidebarConfig);
      //updateStyling(appLayout, sidebarConfig);
      subscribeEvents(appLayout, sidebarConfig, contentContainer, sidebar);
      setTimeout(function() {
        updateStyling(appLayout, sidebarConfig);
      }, 1);
    } else {
      error2console('buildSidebar', 'Error sidebar in width config!');
    }
  } else {
    log2console('buildSidebar', 'No sidebar in config found!');
  }
}

  // show console message on init
console.info(
  `%c  ${SIDEBAR_CARD_TITLE.padEnd(24)}%c
  Version: ${SIDEBAR_CARD_VERSION.padEnd(9)}      `,
  'color: chartreuse; background: black; font-weight: 700;',
  'color: white; background: dimgrey; font-weight: 700;'
);

buildSidebar();
watchLocationChange();