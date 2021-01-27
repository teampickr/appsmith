import { GenericApiResponse } from "api/ApiResponses";
import DatasourcesApi from "api/DatasourcesApi";
import { Datasource } from "entities/Datasource";
import { Plugin } from "api/PluginApi";
import {
  ReduxActionErrorTypes,
  ReduxActionTypes,
} from "constants/ReduxActionConstants";
import { AppState } from "reducers";
import {
  all,
  cancel,
  delay,
  put,
  select,
  take,
  takeEvery,
} from "redux-saga/effects";
import {
  getCanvasWidgets,
  getDatasources,
  getPlugins,
} from "selectors/entitiesSelector";
import { getDataTree } from "selectors/dataTreeSelectors";
import { getCurrentOrgId } from "selectors/organizationSelectors";
import {
  getOnboardingState,
  getOnboardingWelcomeState,
  setOnboardingState,
  setOnboardingWelcomeState,
} from "utils/storage";
import { validateResponse } from "./ErrorSagas";
import { getSelectedWidget, getWidgets } from "./selectors";
import {
  setCurrentStep,
  setOnboardingState as setOnboardingReduxState,
  showIndicator,
} from "actions/onboardingActions";
import {
  changeDatasource,
  expandDatasourceEntity,
} from "actions/datasourceActions";
import { playOnboardingAnimation } from "utils/helpers";
import {
  OnboardingConfig,
  OnboardingStep,
} from "constants/OnboardingConstants";
import AnalyticsUtil from "../utils/AnalyticsUtil";
import { get } from "lodash";
import { AppIconCollection } from "components/ads/AppIcon";
import { getUserApplicationsOrgs } from "selectors/applicationSelectors";
import { getThemeDetails } from "selectors/themeSelectors";
import { getRandomPaletteColor, getNextEntityName } from "utils/AppsmithUtils";
import { getCurrentUser } from "selectors/usersSelectors";
import {
  getCurrentApplicationId,
  getCurrentPageId,
} from "selectors/editorSelectors";
import { createActionRequest, runActionInit } from "actions/actionActions";
import { QUERY_EDITOR_URL_WITH_SELECTED_PAGE_ID } from "constants/routes";
import { QueryAction } from "entities/Action";
import history from "utils/history";
import { getQueryIdFromURL } from "pages/Editor/Explorer/helpers";
import {
  calculateNewWidgetPosition,
  getNextWidgetName,
} from "./WidgetOperationSagas";
import { RenderModes, WidgetTypes } from "constants/WidgetConstants";
import { generateReactKey } from "utils/generators";
import { forceOpenPropertyPane } from "actions/widgetActions";
import { navigateToCanvas } from "pages/Editor/Explorer/Widgets/WidgetEntity";
import { updateWidgetProperty } from "../actions/controlActions";

export const getCurrentStep = (state: AppState) =>
  state.ui.onBoarding.currentStep;
export const inOnboarding = (state: AppState) =>
  state.ui.onBoarding.inOnboarding;
export const isAddWidgetComplete = (state: AppState) =>
  state.ui.onBoarding.addedWidget;
export const showCompletionDialog = (state: AppState) => {
  const isInOnboarding = inOnboarding(state);
  const currentStep = getCurrentStep(state);

  return isInOnboarding && currentStep === OnboardingStep.DEPLOY;
};
export const getInitialTableData = (state: AppState) => {
  const widgetConfig = state.entities.widgetConfig;

  return widgetConfig.config.TABLE_WIDGET.tableData;
};
export const getHelperConfig = (step: OnboardingStep) => {
  return OnboardingConfig[step].helper;
};

function* listenForWidgetAdditions() {
  while (true) {
    yield take();

    const selectedWidget = yield select(getSelectedWidget);
    const canvasWidgets = yield select(getCanvasWidgets);
    const initialTableData = yield select(getInitialTableData);

    // Updating the tableData property to []
    if (
      selectedWidget &&
      selectedWidget.type === "TABLE_WIDGET" &&
      canvasWidgets[selectedWidget.widgetId]
    ) {
      if (selectedWidget.tableData === initialTableData) {
        yield put(
          updateWidgetProperty(selectedWidget.widgetId, { tableData: [] }),
        );
      }

      AnalyticsUtil.logEvent("ONBOARDING_ADD_WIDGET");
      yield put(setCurrentStep(OnboardingStep.ADD_WIDGET));
      yield put({
        type: ReduxActionTypes.ADD_WIDGET_COMPLETE,
      });
      yield put({
        type: ReduxActionTypes.SET_HELPER_CONFIG,
        payload: getHelperConfig(OnboardingStep.ADD_WIDGET),
      });

      return;
    }
  }
}

function* listenForSuccessfulBinding() {
  while (true) {
    yield take();

    let bindSuccessful = true;
    const selectedWidget = yield select(getSelectedWidget);
    if (selectedWidget && selectedWidget.type === "TABLE_WIDGET") {
      const dataTree = yield select(getDataTree);

      if (dataTree[selectedWidget.widgetName]) {
        const widgetProperties = dataTree[selectedWidget.widgetName];
        console.log(
          dataTree[selectedWidget.widgetName],
          "dataTree[selectedWidget.widgetName]",
        );
        const dynamicBindingPathList =
          dataTree[selectedWidget.widgetName].dynamicBindingPathList;
        const tableHasData = dataTree[selectedWidget.widgetName].tableData;
        const hasBinding =
          dynamicBindingPathList &&
          !!dynamicBindingPathList.length &&
          dynamicBindingPathList.some(
            (item: { key: string }) => item.key === "tableData",
          );

        bindSuccessful =
          bindSuccessful && hasBinding && tableHasData && tableHasData.length;

        if (widgetProperties.invalidProps) {
          bindSuccessful =
            bindSuccessful &&
            !(
              "tableData" in widgetProperties.invalidProps &&
              widgetProperties.invalidProps.tableData
            );
        }

        if (bindSuccessful) {
          AnalyticsUtil.logEvent("ONBOARDING_SUCCESSFUL_BINDING");
          yield put(setCurrentStep(OnboardingStep.SUCCESSFUL_BINDING));

          yield delay(1000);
          playOnboardingAnimation();

          yield put(setCurrentStep(OnboardingStep.DEPLOY));
          yield put({
            type: ReduxActionTypes.SET_HELPER_CONFIG,
            payload: getHelperConfig(OnboardingStep.SUCCESSFUL_BINDING),
          });
          return;
        }
      }
    }
  }
}

function* createOnboardingDatasource() {
  AnalyticsUtil.logEvent("ONBOARDING_EXAMPLE_DATABASE");

  try {
    yield take([ReduxActionTypes.INITIALIZE_EDITOR_SUCCESS]);

    const organizationId = yield select(getCurrentOrgId);
    const plugins = yield select(getPlugins);
    const postgresPlugin = plugins.find(
      (plugin: Plugin) => plugin.name === "PostgreSQL",
    );
    const datasources: Datasource[] = yield select(getDatasources);
    let onboardingDatasource = datasources.find((datasource) => {
      const host = get(datasource, "datasourceConfiguration.endpoints[0].host");

      return host === "fake-api.cvuydmurdlas.us-east-1.rds.amazonaws.com";
    });

    if (!onboardingDatasource) {
      const datasourceConfig: any = {
        pluginId: postgresPlugin.id,
        name: "ExampleDatabase",
        organizationId,
        datasourceConfiguration: {
          connection: {
            mode: "READ_WRITE",
          },
          endpoints: [
            {
              host: "fake-api.cvuydmurdlas.us-east-1.rds.amazonaws.com",
              port: 5432,
            },
          ],
          authentication: {
            databaseName: "fakeapi",
            username: "fakeapi",
            password: "LimitedAccess123#",
          },
        },
      };

      const datasourceResponse: GenericApiResponse<Datasource> = yield DatasourcesApi.createDatasource(
        datasourceConfig,
      );
      yield validateResponse(datasourceResponse);
      yield put({
        type: ReduxActionTypes.CREATE_DATASOURCE_SUCCESS,
        payload: datasourceResponse.data,
      });

      onboardingDatasource = datasourceResponse.data;
    }

    yield put(expandDatasourceEntity(onboardingDatasource.id));

    yield put({
      type: ReduxActionTypes.CREATE_ONBOARDING_DBQUERY_SUCCESS,
    });

    // Navigate to that datasource page
    yield put(changeDatasource(onboardingDatasource));

    yield put({
      type: ReduxActionTypes.SET_HELPER_CONFIG,
      payload: getHelperConfig(OnboardingStep.EXAMPLE_DATABASE),
    });
    yield put({
      type: ReduxActionTypes.SHOW_ONBOARDING_HELPER,
      payload: true,
    });
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.CREATE_ONBOARDING_DBQUERY_ERROR,
      payload: { error },
    });
  }
}

function* listenForCreateAction() {
  yield take([ReduxActionTypes.CREATE_ACTION_SUCCESS]);
  yield put({
    type: ReduxActionTypes.SET_HELPER_CONFIG,
    payload: getHelperConfig(OnboardingStep.RUN_QUERY),
  });
  AnalyticsUtil.logEvent("ONBOARDING_ADD_QUERY");
  yield put(setCurrentStep(OnboardingStep.RUN_QUERY));

  yield take([
    ReduxActionTypes.UPDATE_ACTION_INIT,
    ReduxActionTypes.QUERY_PANE_CHANGE,
    ReduxActionTypes.RUN_ACTION_INIT,
  ]);

  yield take([ReduxActionTypes.RUN_ACTION_SUCCESS]);
  AnalyticsUtil.logEvent("ONBOARDING_RUN_QUERY");
  yield put({
    type: ReduxActionTypes.SET_HELPER_CONFIG,
    payload: getHelperConfig(OnboardingStep.RUN_QUERY_SUCCESS),
  });
  yield put(showIndicator(OnboardingStep.NONE));

  yield put(setCurrentStep(OnboardingStep.RUN_QUERY_SUCCESS));
}

function* listenForDeploySaga() {
  while (true) {
    yield take();

    yield take(ReduxActionTypes.PUBLISH_APPLICATION_SUCCESS);
    AnalyticsUtil.logEvent("ONBOARDING_DEPLOY");

    yield put(setCurrentStep(OnboardingStep.FINISH));
    yield put({
      type: ReduxActionTypes.SHOW_ONBOARDING_COMPLETION_DIALOG,
      payload: true,
    });
    yield put(setOnboardingReduxState(false));

    return;
  }
}

function* initiateOnboarding() {
  const currentOnboardingState = yield getOnboardingState();
  const onboardingWelcomeState = yield getOnboardingWelcomeState();
  if (currentOnboardingState && onboardingWelcomeState) {
    // AnalyticsUtil.logEvent("ONBOARDING_WELCOME");
    yield put(setOnboardingReduxState(true));
    yield setOnboardingWelcomeState(false);

    yield put(setCurrentStep(OnboardingStep.WELCOME));
    yield put(setCurrentStep(OnboardingStep.EXAMPLE_DATABASE));
  }
}

function* proceedOnboardingSaga() {
  const isInOnboarding = yield select(inOnboarding);

  if (isInOnboarding) {
    yield put({
      type: ReduxActionTypes.INCREMENT_STEP,
    });

    yield setupOnboardingStep();
  }
}

function* setupOnboardingStep() {
  const currentStep: OnboardingStep = yield select(getCurrentStep);
  const currentConfig = OnboardingConfig[currentStep];
  let actions = currentConfig.setup();

  if (actions.length) {
    actions = actions.map((action) => put(action));
    yield all(actions);
  }
}

function* skipOnboardingSaga() {
  const set = yield setOnboardingState(false);
  const resetWelcomeState = yield setOnboardingWelcomeState(false);

  if (set && resetWelcomeState) {
    yield put(setOnboardingReduxState(false));
  }
}

// Cheat actions
function* createApplication() {
  const themeDetails = yield select(getThemeDetails);
  const color = getRandomPaletteColor(themeDetails.theme.colors.appCardColors);
  const icon =
    AppIconCollection[Math.floor(Math.random() * AppIconCollection.length)];

  const currentUser = yield select(getCurrentUser);
  const userOrgs = yield select(getUserApplicationsOrgs);
  const examplesOrganizationId = currentUser.examplesOrganizationId;

  const organization = userOrgs.filter(
    (org: any) => org.organization.id === examplesOrganizationId,
  );
  const applicationList = organization[0].applications;

  const applicationName = getNextEntityName(
    "Untitled application ",
    applicationList.map((el: any) => el.name),
  );

  yield put({
    type: ReduxActionTypes.CREATE_APPLICATION_INIT,
    payload: {
      applicationName,
      orgId: examplesOrganizationId,
      icon,
      color,
    },
  });
}

function* createQuery() {
  const currentPageId = yield select(getCurrentPageId);
  const applicationId = yield select(getCurrentApplicationId);
  const datasources: Datasource[] = yield select(getDatasources);
  const onboardingDatasource = datasources.find((datasource) => {
    const host = get(datasource, "datasourceConfiguration.endpoints[0].host");

    return host === "fake-api.cvuydmurdlas.us-east-1.rds.amazonaws.com";
  });

  if (onboardingDatasource) {
    const payload = {
      name: "ExampleQuery",
      pageId: currentPageId,
      pluginId: onboardingDatasource?.pluginId,
      datasource: {
        id: onboardingDatasource?.id,
      },
      actionConfiguration: {
        body: "select * from public.users limit 10",
      },
    } as Partial<QueryAction>;

    yield put(createActionRequest(payload));
    history.push(
      QUERY_EDITOR_URL_WITH_SELECTED_PAGE_ID(
        applicationId,
        currentPageId,
        currentPageId,
      ),
    );
  }
}

function* executeQuery() {
  const queryId = getQueryIdFromURL();

  if (queryId) {
    yield put(runActionInit(queryId));
  }
}

function* addWidget() {
  try {
    const columns = 8;
    const rows = 7;
    const widgets = yield select(getWidgets);
    const widgetName = getNextWidgetName(widgets, "TABLE_WIDGET");

    let newWidget = {
      type: WidgetTypes.TABLE_WIDGET,
      newWidgetId: generateReactKey(),
      widgetId: "0",
      topRow: 0,
      bottomRow: rows,
      leftColumn: 0,
      rightColumn: columns,
      columns,
      rows,
      parentId: "0",
      widgetName,
      renderMode: RenderModes.CANVAS,
      parentRowSpace: 1,
      parentColumnSpace: 1,
      isLoading: false,
      props: {
        tableData: [],
      },
    };
    const {
      leftColumn,
      topRow,
      rightColumn,
      bottomRow,
    } = yield calculateNewWidgetPosition(newWidget, "0", widgets);

    newWidget = {
      ...newWidget,
      leftColumn,
      topRow,
      rightColumn,
      bottomRow,
    };

    yield put({
      type: ReduxActionTypes.WIDGET_ADD_CHILD,
      payload: newWidget,
    });

    const applicationId = yield select(getCurrentApplicationId);
    const pageId = yield select(getCurrentPageId);

    navigateToCanvas(
      {
        applicationId,
        pageId,
      },
      window.location.pathname,
      pageId,
      newWidget.newWidgetId,
    );
    yield put({
      type: ReduxActionTypes.SELECT_WIDGET,
      payload: { widgetId: newWidget.newWidgetId },
    });
    yield put(forceOpenPropertyPane(newWidget.newWidgetId));
  } catch (error) {}
}

function* addBinding() {
  const selectedWidget = yield select(getSelectedWidget);

  if (selectedWidget && selectedWidget.type === "TABLE_WIDGET") {
    yield put({
      type: "UPDATE_WIDGET_PROPERTY_REQUEST",
      payload: {
        widgetId: selectedWidget.widgetId,
        propertyName: "tableData",
        propertyValue: "{{ExampleQuery.data}}",
      },
    });
  }
}

function* deploy() {
  const applicationId = yield select(getCurrentApplicationId);
  yield put({
    type: ReduxActionTypes.PUBLISH_APPLICATION_INIT,
    payload: {
      applicationId,
    },
  });
}

export default function* onboardingSagas() {
  yield all([
    takeEvery(ReduxActionTypes.CREATE_APPLICATION_SUCCESS, initiateOnboarding),
    takeEvery(
      ReduxActionTypes.CREATE_ONBOARDING_DBQUERY_INIT,
      createOnboardingDatasource,
    ),
    takeEvery(ReduxActionTypes.NEXT_ONBOARDING_STEP, proceedOnboardingSaga),
    takeEvery(ReduxActionTypes.LISTEN_FOR_CREATE_ACTION, listenForCreateAction),
    takeEvery(ReduxActionTypes.LISTEN_FOR_ADD_WIDGET, listenForWidgetAdditions),
    takeEvery(
      ReduxActionTypes.LISTEN_FOR_TABLE_WIDGET_BINDING,
      listenForSuccessfulBinding,
    ),
    takeEvery(ReduxActionTypes.SET_CURRENT_STEP, setupOnboardingStep),
    takeEvery(ReduxActionTypes.LISTEN_FOR_DEPLOY, listenForDeploySaga),
    // Cheat actions
    takeEvery("ONBOARDING_CREATE_APPLICATION", createApplication),
    takeEvery("ONBOARDING_CREATE_QUERY", createQuery),
    takeEvery("ONBOARDING_RUN_QUERY", executeQuery),
    takeEvery("ONBOARDING_ADD_WIDGET", addWidget),
    takeEvery("ONBOARDING_ADD_BINDING", addBinding),
    takeEvery("ONBOARDING_DEPLOY", deploy),
  ]);

  yield take(ReduxActionTypes.END_ONBOARDING);
  yield skipOnboardingSaga();
  yield cancel();
}
