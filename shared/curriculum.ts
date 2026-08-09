export const curriculumLessons = [
  { id: "first-spark", title: "First Spark", version: 1 },
  { id: "morse-name", title: "Morse Name", version: 1 },
  { id: "button-reaction", title: "Button Reaction", version: 1 },
  { id: "distance-scout", title: "Distance Scout", version: 1 },
  { id: "servo-gate", title: "Servo Gate", version: 1 },
  { id: "trail-rover", title: "Trail Rover", version: 1 },
] as const;

export type LessonSlug = (typeof curriculumLessons)[number]["id"];

export const lessonSlugs = curriculumLessons.map((lesson) => lesson.id) as readonly LessonSlug[];

export function findCurriculumLesson(id: string) {
  return curriculumLessons.find((lesson) => lesson.id === id);
}

export function isLessonSlug(value: string): value is LessonSlug {
  return curriculumLessons.some((lesson) => lesson.id === value);
}
