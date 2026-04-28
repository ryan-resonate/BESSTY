// Mirrors docs/firestore-schema.md.
/// Pick the right limit for a receiver given the active scenario period.
export function limitForPeriod(r, period) {
    switch (period) {
        case 'day': return r.limitDayDbA ?? r.limitDbA ?? 40;
        case 'evening': return r.limitEveningDbA ?? r.limitDbA ?? 40;
        case 'night': return r.limitNightDbA ?? r.limitDbA ?? 40;
    }
}
