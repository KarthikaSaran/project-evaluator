import { ProjectData, ProjectCategory } from "./types";
import rawProjectData from "./projectData.json";

export const ALL_PROJECTS: ProjectData[] = rawProjectData as ProjectData[];

export function getProjectsByCategory(
  category: ProjectCategory
): ProjectData[] {
  return ALL_PROJECTS.filter((p) => p.category === category);
}

export function findProjectById(id: string): ProjectData | undefined {
  return ALL_PROJECTS.find((p) => p.id === id);
}

export function getAllProjectIds(): string[] {
  return ALL_PROJECTS.map((p) => p.id);
}

export function getProjectTitleMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of ALL_PROJECTS) {
    map[p.id] = p.title;
  }
  return map;
}
