#!/bin/env node
//
// WARNING: `CI_SECRET_AIO_DEPLOY_FIREBASE_TOKEN` should NOT be printed.
//
'use strict';

const {cd, cp, exec, mv, sed, set} = require('shelljs');

set('-e');


// Constants
const REPO_SLUG = 'angular/angular';
const NG_REMOTE_URL = `https://github.com/${REPO_SLUG}.git`;
const GIT_REMOTE_REFS_CACHE = new Map();

// Exports
module.exports = {
  computeDeploymentsInfo,
  computeInputVars,
  computeMajorVersion,
  getLatestCommit,
  getMostRecentMinorBranch,
  skipDeployment,
  validateDeploymentsInfo,
};

// Run
if (require.main === module) {
  const isDryRun = process.argv[2] === '--dry-run';
  const inputVars = computeInputVars(process.env);
  const deploymentsInfo = computeDeploymentsInfo(inputVars);
  const totalDeployments = deploymentsInfo.length;

  validateDeploymentsInfo(deploymentsInfo);

  console.log(`Deployments (${totalDeployments}): ${listDeployTargetNames(deploymentsInfo)}`);

  deploymentsInfo.forEach((deploymentInfo, idx) => {
    const logLine1 = `Deployment ${idx + 1} of ${totalDeployments}: ${deploymentInfo.name}`;
    console.log(`\n\n\n${logLine1}\n${'-'.repeat(logLine1.length)}`);

    if (deploymentInfo.type === 'skipped') {
      console.log(deploymentInfo.reason);
    } else {
      console.log(
          `Git branch          : ${inputVars.currentBranch}\n` +
          `Git commit          : ${inputVars.currentCommit}\n` +
          `Build/deploy mode   : ${deploymentInfo.deployEnv}\n` +
          `Firebase project    : ${deploymentInfo.projectId}\n` +
          `Firebase site       : ${deploymentInfo.siteId}\n` +
          `Pre-deploy actions  : ${serializeActions(deploymentInfo.preDeployActions)}\n` +
          `Post-deploy actions : ${serializeActions(deploymentInfo.postDeployActions)}\n` +
          `Deployment URLs     : ${deploymentInfo.deployedUrl}\n` +
          `                      https://${deploymentInfo.siteId}.web.app/`);

      if (!isDryRun) {
        deploy({...inputVars, ...deploymentInfo});
      }
    }
  });
}

// Helpers
function build({deployedUrl, deployEnv}) {
  console.log('\n\n\n==== Build the AIO app. ====\n');
  yarn(`build --configuration=${deployEnv} --progress=false`);

  console.log('\n\n\n==== Add any mode-specific files into the AIO distribution. ====\n');
  cp('-rf', `src/extra-files/${deployEnv}/.`, 'dist/');

  console.log('\n\n\n==== Update opensearch descriptor for AIO with `deployedUrl`. ====\n');
  yarn(`set-opensearch-url ${deployedUrl.replace(/[^/]$/, '$&/')}`);  // The URL must end with `/`.
}

function checkPayloadSize() {
  console.log('\n\n\n==== Check payload size and upload the numbers to Firebase DB. ====\n');
  yarn('payload-size');
}

function computeDeploymentsInfo(
    {currentBranch, currentCommit, isPullRequest, repoName, repoOwner, stableBranch}) {
  // Do not deploy if we are running in a fork.
  if (`${repoOwner}/${repoName}` !== REPO_SLUG) {
    return [skipDeployment(`Skipping deploy because this is not ${REPO_SLUG}.`)];
  }

  // Do not deploy if this is a PR. PRs are deployed in the `aio_preview` CircleCI job.
  if (isPullRequest) {
    return [skipDeployment('Skipping deploy because this is a PR build.')];
  }

  // Do not deploy if the current commit is not the latest on its branch.
  const latestCommit = getLatestCommit(currentBranch);
  if (currentCommit !== latestCommit) {
    return [
      skipDeployment(
          `Skipping deploy because ${currentCommit} is not the latest commit (${latestCommit}).`),
    ];
  }

  // The deployment mode is computed based on the branch we are building.
  const currentBranchMajorVersion = computeMajorVersion(currentBranch);
  const deploymentInfoPerTarget = {
    // PRIMARY DEPLOY TARGETS
    //
    // These targets are responsible for building the app (and setting the theme/mode).
    // Unless deployment is skipped, exactly one primary target should be used at a time and it
    // should be the first item of the returned deploy target list.
    next: {
      name: 'next',
      type: 'primary',
      deployEnv: 'next',
      projectId: 'angular-io',
      siteId: 'next-angular-io-site',
      deployedUrl: 'https://next.angular.io/',
      preDeployActions: [build, checkPayloadSize],
      postDeployActions: [testPwaScore],
    },
    rc: {
      name: 'rc',
      type: 'primary',
      deployEnv: 'rc',
      projectId: 'angular-io',
      siteId: 'rc-angular-io-site',
      deployedUrl: 'https://rc.angular.io/',
      preDeployActions: [build, checkPayloadSize],
      postDeployActions: [testPwaScore],
    },
    stable: {
      name: 'stable',
      type: 'primary',
      deployEnv: 'stable',
      projectId: 'angular-io',
      siteId: `v${currentBranchMajorVersion}-angular-io-site`,
      deployedUrl: 'https://angular.io/',
      preDeployActions: [build, checkPayloadSize],
      postDeployActions: [testPwaScore],
    },
    archive: {
      name: 'archive',
      type: 'primary',
      deployEnv: 'archive',
      projectId: 'angular-io',
      siteId: `v${currentBranchMajorVersion}-angular-io-site`,
      deployedUrl: `https://v${currentBranchMajorVersion}.angular.io/`,
      preDeployActions: [build, checkPayloadSize],
      postDeployActions: [testPwaScore],
    },

    // SECONDARY DEPLOY TARGETS
    //
    // These targets can be used to re-deploy the build artifacts from a primary target (potentially
    // with small tweaks) to a different project/site.
    // Unless deployment is skipped, zero or more secondary targets can be used at a time, but they
    // should all match the primary target's `deployEnv`.

    // Config for deploying the stable build to the RC Firebase site when there is no active RC.
    // See https://github.com/angular/angular/issues/39760 for more info on the purpose of this
    // special deployment.
    noActiveRc: {
      name: 'stableNoActiveRc',
      type: 'secondary',
      deployEnv: 'stable',
      projectId: 'angular-io',
      siteId: 'rc-angular-io-site',
      deployedUrl: 'https://rc.angular.io/',
      preDeployActions: [removeServiceWorker, redirectToAngularIo],
      postDeployActions: [testNoActiveRcDeployment],
    },
  };

  // If the current branch is `master`, deploy as `next`.
  if (currentBranch === 'master') {
    return [deploymentInfoPerTarget.next];
  }

  // Determine if there is an active RC version by checking whether the most recent minor branch is
  // the stable branch or not.
  const mostRecentMinorBranch = getMostRecentMinorBranch();
  const rcBranch = (mostRecentMinorBranch !== stableBranch) ? mostRecentMinorBranch : null;

  // If the current branch is the RC branch, deploy as `rc`.
  if (currentBranch === rcBranch) {
    return [deploymentInfoPerTarget.rc];
  }

  // If the current branch is the stable branch, deploy as `stable`.
  if (currentBranch === stableBranch) {
    return (rcBranch !== null) ?
      // There is an active RC version. Only deploy to the `stable` project/site.
      [deploymentInfoPerTarget.stable] :
      // There is no active RC version. In addition to deploying to the `stable` project/site,
      // deploy to `rc` to ensure it redirects to `stable`.
      // See https://github.com/angular/angular/issues/39760 for more info on the purpose of this
      // special deployment.
      [
        deploymentInfoPerTarget.stable,
        deploymentInfoPerTarget.noActiveRc,
      ];
  }

  // If we get here, it means that the current branch is neither `master`, nor the RC or stable
  // branches. At this point, we may only deploy as `archive` and only if the following criteria are
  // met:
  //   1. The current branch must have the highest minor version among all branches with the same
  //      major version.
  //   2. The current branch must have a major version that is lower than the stable major version.

  // Do not deploy if it is not the branch with the highest minor for the given major version.
  const mostRecentMinorBranchForMajor = getMostRecentMinorBranch(currentBranchMajorVersion);
  if (currentBranch !== mostRecentMinorBranchForMajor) {
    return [
      skipDeployment(
          `Skipping deploy of branch "${currentBranch}" to Firebase.\n` +
          'There is a more recent branch with the same major version: ' +
          `"${mostRecentMinorBranchForMajor}"`),
    ];
  }

  // Do not deploy if it does not have a lower major version than stable.
  const stableBranchMajorVersion = computeMajorVersion(stableBranch);
  if (currentBranchMajorVersion >= stableBranchMajorVersion) {
    return [
      skipDeployment(
          `Skipping deploy of branch "${currentBranch}" to Firebase.\n` +
          'This branch has an equal or higher major version than the stable branch ' +
          `("${stableBranch}") and is not the most recent minor branch.`),
    ];
  }

  // This is the highest minor version for a major that is lower than the stable major version:
  // Deploy as `archive`.
  return [deploymentInfoPerTarget.archive];
}

function computeInputVars({
  CI_AIO_MIN_PWA_SCORE: minPwaScore,
  CI_BRANCH: currentBranch,
  CI_COMMIT: currentCommit,
  CI_PULL_REQUEST,
  CI_REPO_NAME: repoName,
  CI_REPO_OWNER: repoOwner,
  CI_SECRET_AIO_DEPLOY_FIREBASE_TOKEN: firebaseToken,
  CI_STABLE_BRANCH: stableBranch,
}) {
  return {
    currentBranch,
    currentCommit,
    firebaseToken,
    isPullRequest: CI_PULL_REQUEST !== 'false',
    minPwaScore,
    repoName,
    repoOwner,
    stableBranch,
  };
}

function computeMajorVersion(branchName) {
  return +branchName.split('.', 1)[0];
}

function deploy(data) {
  const {
    currentCommit,
    firebaseToken,
    postDeployActions,
    preDeployActions,
    projectId,
    siteId,
  } = data;

  cd(`${__dirname}/../..`);

  console.log('\n\n\n==== Run pre-deploy actions. ====\n');
  preDeployActions.forEach(fn => fn(data));

  console.log('\n\n\n==== Deploy AIO to Firebase hosting. ====\n');
  const firebase = cmd => yarn(`firebase ${cmd} --token "${firebaseToken}"`);
  firebase(`use "${projectId}"`);
  firebase('target:clear hosting aio');
  firebase(`target:apply hosting aio "${siteId}"`);
  firebase(`deploy --only hosting:aio --message "Commit: ${currentCommit}" --non-interactive`);

  console.log('\n\n\n==== Run post-deploy actions. ====\n');
  postDeployActions.forEach(fn => fn(data));
}

function getRemoteRefs(refOrPattern, {remote = NG_REMOTE_URL, retrieveFromCache = true} = {}) {
  // If remote refs for the same `refOrPattern` and `remote` have been requested before, return the
  // cached results. This improves the performance and ensures a more stable behavior.
  //
  // NOTE:
  // This shouldn't make any difference during normal execution (since there are no duplicate
  // requests atm), but makes the tests more stable (for example, avoiding errors caused by pushing
  // a new commit on a branch while the tests execute, which would cause `getLatestCommit()` to
  // return a different value).
  const cmd = `git ls-remote ${remote} ${refOrPattern}`;
  const result = (retrieveFromCache && GIT_REMOTE_REFS_CACHE.has(cmd)) ?
    GIT_REMOTE_REFS_CACHE.get(cmd) :
    exec(cmd, {silent: true}).trim().split('\n');

  // Cache the result for future use (regardless of the value of `retrieveFromCache`).
  GIT_REMOTE_REFS_CACHE.set(cmd, result);

  return result;
}

function getMostRecentMinorBranch(major = '*', options = undefined) {
  // List the branches that start with the given major version (or any major if none given).
  return getRemoteRefs(`refs/heads/${major}.*.x`, options)
      // Extract the branch name.
      .map(line => line.split('/')[2])
      // Filter out branches that are not of the format `<number>.<number>.x`.
      .filter(name => /^\d+\.\d+\.x$/.test(name))
      // Sort by version.
      .sort((a, b) => {
        const [majorA, minorA] = a.split('.');
        const [majorB, minorB] = b.split('.');
        return (majorA - majorB) || (minorA - minorB);
      })
      // Get the branch corresponding to the highest version.
      .pop();
}

function getLatestCommit(branchName, options = undefined) {
  return getRemoteRefs(branchName, options)[0].slice(0, 40);
}

function listDeployTargetNames(deploymentsList) {
  return deploymentsList.map(({name = '<no name>'}) => name).join(', ') || '-';
}

function redirectToAngularIo() {
  // Update the Firebase hosting configuration redirect all non-file requests (i.e. requests that do
  // not contain a dot in their last path segment) to `angular.io`.
  // See https://firebase.google.com/docs/hosting/full-config#redirects.
  const redirectRule =
      '{"type": 302, "regex": "^(.*/[^./]*)$", "destination": "https://angular.io:1"}';
  sed('-i', /(\s*)"redirects": \[/, `$&\n$1  ${redirectRule},\n`, 'firebase.json');
}

function removeServiceWorker() {
  // Rename the SW manifest (`ngsw.json`). This will cause the ServiceWorker to unregister itself.
  // See https://angular.io/guide/service-worker-devops#fail-safe.
  mv('dist/ngsw.json', 'dist/ngsw.json.bak');
}

function serializeActions(actions) {
  return actions.map(fn => fn.name).join(', ');
}

function skipDeployment(reason) {
  return {name: 'skipped', type: 'skipped', reason};
}

function testNoActiveRcDeployment({deployedUrl}) {
  const deployedOrigin = deployedUrl.replace(/\/$/, '');

  // Ensure a request for `ngsw.json` returns 404.
  const ngswJsonUrl = `${deployedOrigin}/ngsw.json`;
  const ngswJsonScript = `https.get('${ngswJsonUrl}', res => console.log(res.statusCode))`;
  const ngswJsonActualStatusCode = exec(`node --eval "${ngswJsonScript}"`, {silent: true}).trim();
  const ngswJsonExpectedStatusCode = '404';

  if (ngswJsonActualStatusCode !== ngswJsonExpectedStatusCode) {
    throw new Error(
        `Expected '${ngswJsonUrl}' to return a status code of '${ngswJsonExpectedStatusCode}', ` +
        `but it returned '${ngswJsonActualStatusCode}'.`);
  }

  // Ensure a request for `foo/bar` is redirected to `https://angular.io/foo/bar`.
  const fooBarUrl = `${deployedOrigin}/foo/bar?baz=qux`;
  const fooBarScript =
      `https.get('${fooBarUrl}', res => console.log(res.statusCode, res.headers.location))`;
  const [fooBarActualStatusCode, fooBarActualRedirectUrl] =
      exec(`node --eval "${fooBarScript}"`, {silent: true}).trim().split(' ');
  const fooBarExpectedStatusCode = '302';
  const fooBarExpectedRedirectUrl = 'https://angular.io/foo/bar?baz=qux';

  if (fooBarActualStatusCode !== fooBarExpectedStatusCode) {
    throw new Error(
        `Expected '${fooBarUrl}' to return a status code of '${fooBarExpectedStatusCode}', but ` +
        `it returned '${fooBarActualStatusCode}'.`);
  } else if (fooBarActualRedirectUrl !== fooBarExpectedRedirectUrl) {
    const actualBehavior = (fooBarActualRedirectUrl === 'undefined') ?
      'not redirected' : `redirected to '${fooBarActualRedirectUrl}'`;
    throw new Error(
        `Expected '${fooBarUrl}' to be redirected to '${fooBarExpectedRedirectUrl}', but it was ` +
        `${actualBehavior}.`);
  }
}

function testPwaScore({deployedUrl, minPwaScore}) {
  console.log('\n\n\n==== Run PWA-score tests. ====\n');
  yarn(`test-pwa-score "${deployedUrl}" "${minPwaScore}"`);
}

function validateDeploymentsInfo(deploymentsList) {
  const knownTargetTypes = ['primary', 'secondary', 'skipped'];
  const requiredPropertiesForSkipped = ['name', 'type', 'reason'];
  const requiredPropertiesForNonSkipped = [
    'name', 'type', 'deployEnv', 'projectId', 'siteId', 'deployedUrl', 'preDeployActions',
    'postDeployActions',
  ];

  const primaryTargets = deploymentsList.filter(({type}) => type === 'primary');
  const secondaryTargets = deploymentsList.filter(({type}) => type === 'secondary');
  const skippedTargets = deploymentsList.filter(({type}) => type === 'skipped');
  const otherTargets = deploymentsList.filter(({type}) => !knownTargetTypes.includes(type));

  // Check that all targets have a known `type`.
  if (otherTargets.length > 0) {
    throw new Error(
        `Expected all deploy targets to have a type of ${knownTargetTypes.join(' or ')}, but ` +
        `found ${otherTargets.length} targets with an unknown type: ` +
        otherTargets.map(({name = '<no name>', type}) => `${name} (type: ${type})`).join(', '));
  }

  // Check that all targets have the required properties.
  for (const target of deploymentsList) {
    const requiredProperties = (target.type === 'skipped') ?
      requiredPropertiesForSkipped : requiredPropertiesForNonSkipped;
    const missingProperties = requiredProperties.filter(prop => target[prop] === undefined);

    if (missingProperties.length > 0) {
      throw new Error(
          `Expected deploy target '${target.name || '<no name>'}' to have all required ` +
          `properties, but it is missing '${missingProperties.join('\', \'')}'.`);
    }
  }

  // If there are skipped targets...
  if (skippedTargets.length > 0) {
    // ...check that exactly one target has been specified.
    if (deploymentsList.length > 1) {
      throw new Error(
          `Expected a single skipped deploy target, but found ${deploymentsList.length} targets ` +
          `in total: ${listDeployTargetNames(deploymentsList)}`);
    }

    // There is only one skipped deploy target and it is valid (i.e. has all required properties).
    return;
  }

  // Check that exactly one primary target has been specified.
  if (primaryTargets.length !== 1) {
    throw new Error(
        `Expected exactly one primary deploy target, but found ${primaryTargets.length}: ` +
        listDeployTargetNames(primaryTargets));
  }

  const primaryTarget = primaryTargets[0];
  const primaryIndex = deploymentsList.indexOf(primaryTarget);

  // Check that the primary target is the first item in the list.
  if (primaryIndex !== 0) {
    throw new Error(
        `Expected the primary target (${primaryTarget.name}) to be the first item in the deploy ` +
        `target list, but it was found at index ${primaryIndex} (0-based): ` +
        listDeployTargetNames(deploymentsList));
  }

  const nonMatchingSecondaryTargets =
      secondaryTargets.filter(({deployEnv}) => deployEnv !== primaryTarget.deployEnv);

  // Check that all secondary targets (if any) match the primary target's `deployEnv`.
  if (nonMatchingSecondaryTargets.length > 0) {
    throw new Error(
        'Expected all secondary deploy targets to match the primary target\'s `deployEnv` ' +
        `(${primaryTarget.deployEnv}), but ${nonMatchingSecondaryTargets.length} targets do not: ` +
        nonMatchingSecondaryTargets.map(t => `${t.name} (deployEnv: ${t.deployEnv})`).join(', '));
  }
}

function yarn(cmd) {
  // Using `--silent` to ensure no secret env variables are printed.
  //
  // NOTE:
  // This is not strictly necessary, since CircleCI will mask secret environment variables in the
  // output (see https://circleci.com/docs/2.0/env-vars/#secrets-masking), but is an extra
  // precaution.
  return exec(`yarn --silent ${cmd}`);
}
