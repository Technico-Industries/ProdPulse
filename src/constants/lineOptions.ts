export const PLANTS = ['Bawal 1', 'Bawal 2'];
export const WORKSHOPS = ['Assembly Shop', 'Welding Shop', 'Plating Shop', 'Press Shop'];
export const DIVISIONS = ['Side Door', 'S. Jack', 'RR Center', 'Break Pedal', 'Hood Hinge', 'Back Door', 'Non-MSIL', 'Count Cable', 'CNC Pipe Bending', 'Bolt Stacking', 'Nissan P1324'];
export const ASSIGN_ROLES = ['Supervisor', 'Technician', 'Restocker', 'Quality Control'];
// Bawal 1 → Welding records production per division (Div-1 … Div-5) the way
// Assembly does per its sections. Every other workshop keeps DIVISIONS.
export const WELDING_DIVISIONS = ['Div-1', 'Div-2', 'Div-3', 'Div-4', 'Div-5'];

export function isWeldingWorkshop(w: string | null | undefined) {
  return !!w && w.toLowerCase().includes('welding');
}

// Workshops whose screens show a Division picker (Assembly as before, plus Welding).
export function workshopHasDivisions(w: string | null | undefined) {
  return !!w && (w.toLowerCase().includes('assembly') || isWeldingWorkshop(w));
}

// The division list for a workshop.
export function divisionsForWorkshop(w: string | null | undefined): string[] {
  return isWeldingWorkshop(w) ? WELDING_DIVISIONS : DIVISIONS;
}
