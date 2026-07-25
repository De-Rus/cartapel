const KEY = 'cartapel-view-as'

export function viewAsRole(): string | null {
  return sessionStorage.getItem(KEY)
}

export function setViewAsRole(role: string | null) {
  if (role) sessionStorage.setItem(KEY, role)
  else sessionStorage.removeItem(KEY)
  window.location.reload()
}
