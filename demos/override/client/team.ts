import type { Leaderboard } from './types.ts';
import { boardRow, empty } from './board.ts';
import { escape as esc } from './html.ts';
import { plain, t } from './text.ts';


/** Read at use time so the admin's edit applies. */
export const nameError = (): string => plain('team.nameError');

/** Mirrors the server name rule: trimmed, whitespace collapsed, NFC, 2-24 chars, letters/digits/spaces and ' ’ & . - ! ? #, first char a letter or digit. */
export function teamNameError(raw: string): string | null {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ').normalize('NFC');
  const length = [...name].length;
  if (length < 2 || length > 24) return nameError();
  if (!/^[\p{L}\p{N}]/u.test(name)) return nameError();
  if (!/^[\p{L}\p{N} '’&.\-!?#]+$/u.test(name)) return nameError();
  return null;
}

/** `agreed` is the research-consent box; `privacy` swaps the form for the data notice. Both default off. */
export interface GateView { name: string; error: string; taken: string | null; busy: boolean; switching: boolean; agreed?: boolean; privacy?: boolean }

/** The data notice, shown in the gate's place. Its back button returns to the form with name and box kept. */
export function privacyPanel(): string {
  const rows = [
    [t('team.privacy.saved.label'), t('team.privacy.saved.body')],
    [t('team.privacy.needed.label'), t('team.privacy.needed.body')],
    [t('team.privacy.why.label'), t('team.privacy.why.body')],
    [t('team.privacy.public.label'), t('team.privacy.public.body')],
    [t('team.privacy.where.label'), t('team.privacy.where.body')],
    [t('team.privacy.delete.label'), t('team.privacy.delete.body')],
  ].map(([label, body]) => `<dt>${label}</dt><dd>${body}</dd>`).join('');
  return `<div class="reset-card team-gate team-privacy"><span class="eyebrow">${t('team.privacy.eyebrow')}</span><h2>${t('team.privacy.title')}</h2>` +
    `<dl class="privacy-rows">${rows}</dl>` +
    `<div class="team-actions"><button type="button" id="privacy-back" class="secondary-button">${t('team.privacy.back')}</button></div></div>`;
}

export function teamGate(view: GateView): string {
  if (view.privacy) return privacyPanel();
  const dis = view.busy ? ' disabled' : '';
  const agreed = view.agreed === true;
  const consent = `<div class="team-consent"><p class="consent-notice">${t('team.consent.notice')} ` +
    `<button type="button" id="privacy-open" class="link-button">${t('team.consent.more')}</button></p>` +
    `<label class="consent-check" for="team-consent"><input id="team-consent" type="checkbox"${agreed ? ' checked' : ''}><span>${t('team.consent.label')}</span></label>` +
    `<p id="team-consent-note" class="consent-note">${t(agreed ? 'team.consent.thanks' : 'team.consent.needed')}</p></div>`;
  const taken = view.taken
    ? `<div class="team-taken"><p>${t('team.taken', { name: view.taken })}</p>` +
      `<button type="button" id="team-other" class="primary-button"${dis}>${t('team.other')}</button></div>`
    : '';
  const cancel = view.switching ? `<button type="button" id="team-cancel" class="secondary-button">${t('team.cancel')}</button>` : '';
  return `<div class="reset-card team-gate"><span class="eyebrow">${t('team.eyebrow')}</span><h2>${t('team.title')}</h2>` +
    `<p class="team-hint">${t('team.hint')}</p>` +
    `<form id="team-form" class="team-form" novalidate><label for="team-name">${t('team.nameLabel')}</label>` +
    `<input id="team-name" name="team" type="text" maxlength="24" autocomplete="off" value="${esc(view.name)}">` +
    `${consent}<p id="team-error" class="team-error" role="alert">${esc(view.error)}</p>${taken}` +
    `<div class="team-actions">${cancel}<button type="submit" id="team-submit" class="primary-button"${view.busy || !agreed ? ' disabled' : ''}>${t('team.submit')}</button></div></form></div>`;
}

export function leaderboardPanel(board: Pick<Leaderboard, 'teams' | 'cases'>): string {
  const note = `<p class="fine-print">${t('team.note')}</p>`;
  if (!board.teams.length) return `<p class="board-empty">${empty()}</p>${note}`;
  const caption = t('team.ties.coins');
  const cases = board.cases || [];
  const head = cases.length ? `<th>${t('team.col.cases')}</th>` : '';
  return `<table class="board-table"><caption>${caption}</caption>` +
    `<thead><tr><th>${t('team.col.rank')}</th><th>${t('team.col.team')}</th>${head}<th>${t('team.col.points')}</th><th>${t('team.col.coins')}</th></tr></thead>` +
    `<tbody>${board.teams.map(r => boardRow(r, cases, plain('team.playing'))).join('')}</tbody></table>${note}`;
}
