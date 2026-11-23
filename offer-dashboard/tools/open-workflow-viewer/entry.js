import "@openworkflowspec/diagram-editor/styles.css";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { DiagramEditor } from "@openworkflowspec/diagram-editor";

/*
 * Espone il globale window.OpenWorkflowViewer e nasconde React:
 *   const v = OpenWorkflowViewer.mount(container, { content, locale, colorMode });
 *   v.update({ content });  v.unmount();
 * Il viewer è sempre in sola lettura.
 */
function mount(container, options) {
  const root = createRoot(container);
  let current = Object.assign({ content: "", locale: "en", colorMode: "light" }, options);
  const render = () =>
    root.render(
      createElement(DiagramEditor, {
        content: current.content,
        isReadOnly: true,
        locale: current.locale,
        colorMode: current.colorMode,
      }),
    );
  render();
  return {
    update(next) {
      current = Object.assign({}, current, next);
      render();
    },
    unmount() {
      root.unmount();
    },
  };
}

window.OpenWorkflowViewer = { mount: mount };
