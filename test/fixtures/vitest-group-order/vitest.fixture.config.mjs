import path from "node:path";
import { fileURLToPath } from "node:url";
import viteConfigFactory from "../../../vite.config.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const liveConfig = viteConfigFactory({ command: "build", mode: "test" });
const projectsByName = new Map(
  liveConfig.test.projects.map(project => [project.test.name, project]),
);
const invertOrder =
  process.env.PDF_TOOLS_VITEST_ORDER_CONTROL === "source-first";

function retargetProject(name, include) {
  const project = projectsByName.get(name);
  if (!project) throw new Error(`missing live Vitest project: ${name}`);
  const groupOrder = invertOrder
    ? (name === "ordinary" ? 2 : 1)
    : project.test.sequence.groupOrder;
  return {
    ...project,
    test: {
      ...project.test,
      root: repoRoot,
      include: [include],
      exclude: [],
      sequence: {
        ...project.test.sequence,
        groupOrder,
      },
    },
  };
}

export default {
  test: {
    root: repoRoot,
    passWithNoTests: false,
    projects: [
      retargetProject(
        "ordinary",
        "test/fixtures/vitest-group-order/ordinary.fixture.mjs",
      ),
      retargetProject(
        "source-identity",
        "test/fixtures/vitest-group-order/source-identity.fixture.mjs",
      ),
    ],
  },
};
