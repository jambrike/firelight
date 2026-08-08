import { createContext, useContext } from "react";
import { FirelightHardwareApi } from "./compiler-client";
import { WebSerialArduinoTransport } from "./web-serial";
import { HardwareWorkflowController } from "./workflow";

export type HardwareWorkflowFactory = (
  getAccessToken: () => string | null,
) => HardwareWorkflowController;

export const defaultHardwareWorkflowFactory: HardwareWorkflowFactory = (getAccessToken) => {
  const api = new FirelightHardwareApi(getAccessToken);
  return new HardwareWorkflowController({
    compiler: api,
    transport: new WebSerialArduinoTransport(),
    evidenceRecorder: api,
  });
};

export const HardwareWorkflowFactoryContext = createContext<HardwareWorkflowFactory>(
  defaultHardwareWorkflowFactory,
);

export function useHardwareWorkflowFactory(): HardwareWorkflowFactory {
  return useContext(HardwareWorkflowFactoryContext);
}
