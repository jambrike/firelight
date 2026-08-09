import { findLesson } from "../features/lessons/catalog";

export interface RouteMetadata {
  readonly announcement: string;
  readonly title: string;
}

const routeMetadata: Readonly<Record<string, RouteMetadata>> = {
  "/": {
    announcement: "Firelight home",
    title: "Build real robots",
  },
  "/kit": {
    announcement: "Kit and safety",
    title: "Kit",
  },
  "/auth": {
    announcement: "Account entry",
    title: "Set up camp",
  },
  "/activate": {
    announcement: "Kit activation",
    title: "Activate a kit",
  },
  "/camp": {
    announcement: "Learner camp",
    title: "Camp",
  },
  "/learn": {
    announcement: "Build path",
    title: "Learn",
  },
  "/account": {
    announcement: "Builder account",
    title: "Account",
  },
  "/admin": {
    announcement: "Pilot support",
    title: "Pilot support",
  },
};

export function getRouteMetadata(location: string): RouteMetadata {
  const pathname = location.split("?", 1)[0] ?? "/";
  const knownRoute = routeMetadata[pathname];

  if (knownRoute) {
    return knownRoute;
  }

  if (pathname.startsWith("/learn/")) {
    const lessonId = pathname.slice("/learn/".length);
    const lesson = findLesson(lessonId);

    if (lesson) {
      return {
        announcement: `${lesson.title} lesson`,
        title: lesson.title,
      };
    }
  }

  return {
    announcement: "Page not found",
    title: "Trail marker missing",
  };
}
