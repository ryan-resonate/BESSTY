import { collection, getDocs, orderBy, query } from 'firebase/firestore';
import { db, isFirebaseConfigured } from './firebase';
import { ensureDemoSeeded, listLocalProjects } from './storage';
// Mock data used as a final fallback if neither Firebase nor localStorage
// has any projects (shouldn't happen in normal use because we seed a demo
// project on first load).
const MOCK_PROJECTS = [
    {
        id: 'mock-mtbrown',
        name: 'Mt Brown Wind Farm — Stage 2',
        description: '24 × V163-4.5 MW with adjacent BESS pad. Layout review.',
        updatedAt: '2026-04-27T14:22:00Z',
        sourceCount: 30,
        receiverCount: 8,
    },
    {
        id: 'mock-coastline',
        name: 'Coastline BESS — Compliance check',
        description: '60 × Megapack 2 XL, perimeter receivers, Period: night.',
        updatedAt: '2026-04-25T09:14:00Z',
        sourceCount: 60,
        receiverCount: 12,
    },
    {
        id: 'mock-ridge',
        name: 'Ridge Vista WF feasibility',
        description: '16 × N149/5.X, hilly terrain (DEM imported).',
        updatedAt: '2026-04-21T17:08:00Z',
        sourceCount: 16,
        receiverCount: 5,
    },
];
export async function listProjects() {
    if (!isFirebaseConfigured()) {
        ensureDemoSeeded();
        const local = listLocalProjects();
        return local.length > 0 ? local : MOCK_PROJECTS;
    }
    const q = query(collection(db(), 'projects'), orderBy('updatedAt', 'desc'));
    const snap = await getDocs(q);
    return snap.docs.map((doc) => {
        const d = doc.data();
        return {
            id: doc.id,
            name: d.name ?? 'Untitled project',
            description: d.description ?? '',
            updatedAt: d.updatedAt ?? new Date().toISOString(),
            sourceCount: d.sources?.length,
            receiverCount: d.receivers?.length,
        };
    });
}
