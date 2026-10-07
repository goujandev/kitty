import { useProjects } from "../stores/projectStore";
import { Icon } from "./Icon";
import { ProjectMonogram } from "./ProjectMonogram";

/**
 * What the main area shows when no project is open: why a folder is needed,
 * and the one or two ways to get one. Choosing lands straight in a new chat.
 */
export function ProjectChooser({ onNewProject, onStartIn }: {
  onNewProject: () => void;
  onStartIn: (projectId: string) => void;
}): React.ReactElement {
  const { projects } = useProjects();
  const folders = projects.filter(project => project.root !== null && project.exists);
  return <main className="project-chooser" aria-labelledby="project-chooser-title">
    <h1 id="project-chooser-title">{folders.length ? "Choose a project to start a chat." : "Open a project to start working."}</h1>
    <p>Chats happen inside a project folder on your computer, so the agent can read and edit its files.</p>
    <button type="button" className="button button--primary" onClick={onNewProject}><Icon name="folderPlus" size={16} />New project…</button>
    {folders.length > 0 && <>
      <h2 className="project-chooser__label">Or start a chat in</h2>
      <ul className="project-chooser__list">
        {folders.map(project => <li key={project.id}>
          <button type="button" className="project-chooser__project" title={project.root ?? undefined} onClick={() => onStartIn(project.id)}>
            <ProjectMonogram name={project.name} />
            <span className="project-chooser__name">{project.name}</span>
            <span className="project-chooser__path">{project.root}</span>
          </button>
        </li>)}
      </ul>
    </>}
  </main>;
}
