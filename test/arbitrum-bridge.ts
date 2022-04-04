import chai, { expect } from 'chai';
import hardhat, { ethers } from 'hardhat';
import { BigNumber } from 'ethers';
import { solidity } from 'ethereum-waffle';
import {
  DRE,
  advanceBlockTo,
  advanceBlock,
  waitForTx,
  getImpersonatedSigner,
  evmSnapshot,
  evmRevert,
  increaseTime,
} from '../helpers/misc-utils';

import { makeSuite, setupTestEnvironment, TestEnv } from './helpers/make-suite';
import { createArbitrumBridgeTest } from './helpers/bridge-helpers';
import {
  expectProposalState,
  createProposal,
  triggerWhaleVotes,
  queueProposal,
} from './helpers/governance-helpers';
import { AaveGovernanceV2, ArbitrumBridgeExecutor, Executor, Executor__factory, PolygonBridgeExecutor__factory } from '../typechain';
import { ZERO_ADDRESS } from '../helpers/constants';
import { getAaveGovContract } from '../helpers/contract-getters';
import { ADDRESSES } from '../helpers/gov-constants';
import { deployArbitrumBridgeExecutor } from '../helpers/arbitrum-contract-getters';

chai.use(solidity);

const proposalStates = {
  PENDING: 0,
  CANCELED: 1,
  ACTIVE: 2,
  FAILED: 3,
  SUCCEEDED: 4,
  QUEUED: 5,
  EXPIRED: 6,
  EXECUTED: 7,
};

const AAVE_WHALES = [
  '0x26a78d5b6d7a7aceedd1e6ee3229b372a624d8b7',
  '0xf81ccdc1ee8de3fbfa48a0714fc773022e4c14d7',
  '0x4048c47b546b68ad226ea20b5f0acac49b086a21',
];

const NEW_ETHEREUM_GOVERNANCE_EXECUTOR_ADDRESS = '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9';

const ARBITRUM_ETH_WHALE = '0xB38e8c17e38363aF6EbdCb3dAE12e0243582891D';

describe('Arbitrum Bridge', () => {
  const proposals: any = [];
  const dummyUint = 10203040;
  const dummyString = 'Hello';
  const overrides = { gasLimit: 5000000 };

  let statePriorToCancellation;

  let deployer;
  let aaveGovContract: AaveGovernanceV2;
  let shortExecutor: Executor;
  let arbitrumBridgeExecutor: ArbitrumBridgeExecutor;
  let proposal;

  before(async () => {
    await hardhat.run('set-DRE');
    const { deployer: deployerAddress } = await DRE.getNamedAccounts();
    deployer = await DRE.ethers.getSigner(deployerAddress);

    console.log('Network', DRE.network.name, DRE.network.config.chainId);
    console.log((await DRE.ethers.provider.getBlockNumber()).toString());
    await DRE.network.provider.send('hardhat_setBalance', [
      deployerAddress,
      ethers.utils.parseEther('10').toHexString(),
    ]);
    // await DRE.network.provider.request({
    //   method: 'hardhat_impersonateAccount',
    //   params: [ARBITRUM_ETH_WHALE],
    // });
    // const arbitrumWhale = await DRE.ethers.getSigner(ARBITRUM_ETH_WHALE);
    // console.log(
    //   'whale',
    //   (await DRE.ethers.provider.getBalance(await arbitrumWhale.getAddress())).toString()
    // );
    // console.log('llega');
    // await arbitrumWhale.sendTransaction({
    //   to: deployer.address,
    //   value: ethers.utils.parseEther('10'),
    // });

    console.log((await DRE.ethers.provider.getBalance(deployer.address)).toString());
  });

  it('Deploy Arbitrum Bridge Executor', async () => {
    console.log('Deploying ArbitrumBridgeExecutor...');
    arbitrumBridgeExecutor = await deployArbitrumBridgeExecutor(
      ADDRESSES.ETHEREUM_GOV_EXECUTOR,
      BigNumber.from(60),
      BigNumber.from(1000),
      BigNumber.from(15),
      BigNumber.from(500),
      deployer.address, // guardian
      deployer
    );
    console.log('ArbitrumBridgeExecutor: ', arbitrumBridgeExecutor.address);
  });

  it('Submits governance proposal to update ethereum governance executor of ArbitrumBridgeExecutor', async () => {
    console.log('Change network to Ethereum');
    DRE.changeNetwork('ethereumFork');
    console.log(DRE.network.name);
    console.log((await DRE.ethers.provider.getBlockNumber()).toString());
    console.log('ArbitrumBridgeExecutor: ', arbitrumBridgeExecutor.address);
    aaveGovContract = await getAaveGovContract(ADDRESSES.AAVE_GOVERNANCE, deployer);
    shortExecutor = Executor__factory.connect(ADDRESSES.ETHEREUM_GOV_EXECUTOR, deployer);

    const aaveWhale1 = await  ethers.provider.getSigner(AAVE_WHALES[0]);
    const aaveWhale2 = await getImpersonatedSigner(AAVE_WHALES[1]);
    const aaveWhale3 = await getImpersonatedSigner(AAVE_WHALES[2]);

    const encodedAddress = DRE.ethers.utils.defaultAbiCoder.encode(
      ['address'],
      [NEW_ETHEREUM_GOVERNANCE_EXECUTOR_ADDRESS]
    );
    const encodedQueue = arbitrumBridgeExecutor.interface.encodeFunctionData('queue', [
      [arbitrumBridgeExecutor.address],
      [BigNumber.from(0)],
      ['updateEthereumGovernanceExecutor(address)'],
      [encodedAddress],
      [false],
    ]);

    const retryableTicket = {
      destAddr: arbitrumBridgeExecutor.address,
      arbTxCallValue: 0,
      maxSubmissionCost: 0,
      submissionRefundAddress: ZERO_ADDRESS,
      valueRefundAddress: ZERO_ADDRESS,
      maxGas: BigNumber.from(200000).mul(3),
      gasPriceBid: 0,
      data: encodedQueue,
    };

    const encodedRootCalldata = ethers.utils.defaultAbiCoder.encode(
      ['address', 'uint256', 'uint256', 'address', 'address', 'uint256', 'uint256', 'bytes'],
      [
        retryableTicket.destAddr,
        retryableTicket.arbTxCallValue,
        retryableTicket.maxSubmissionCost,
        retryableTicket.submissionRefundAddress,
        retryableTicket.valueRefundAddress,
        retryableTicket.maxGas,
        retryableTicket.gasPriceBid,
        retryableTicket.data,
      ]
    );

    // Submission
    console.log('submit')
    proposal = await createProposal(
      aaveGovContract,
      aaveWhale1,
      shortExecutor.address,
      [ADDRESSES.INBOX_MAIN],
      [BigNumber.from(0)],
      ['createRetryableTicket(address,uint256,uint256,address,address,uint256,uint256,bytes)'],
      [encodedRootCalldata],
      [false],
      '0xf7a1f565fcd7684fba6fea5d77c5e699653e21cb6ae25fbf8c5dbc8d694c7949'
      );
      console.log('submit2')
    console.log(await aaveGovContract.getProposalById(proposal.id));
    await expectProposalState(aaveGovContract, proposal.id, proposalStates.PENDING);
  });

  it('Governance proposal get executed', async () => {
    // const { ethers } = DRE;
    // const { aaveWhale1, aaveWhale2, aaveWhale3, aaveGovContract, shortExecutor } = testEnv;
    // // Vote on Proposal
    // for (let i = 0; i < 18; i++) {
    //   await triggerWhaleVotes(
    //     aaveGovContract,
    //     [aaveWhale1.signer, aaveWhale2.signer, aaveWhale3.signer],
    //     proposals[i].id,
    //     true
    //   );
    //   await expectProposalState(aaveGovContract, proposals[i].id, proposalStates.ACTIVE);
    // }
    // // Advance Block to End of Voting
    // await advanceBlockTo(proposals[17].endBlock.add(1));
    // // Queue Proposal
    // const queuedProposal18 = await queueProposal(aaveGovContract, proposals[17].id);
    // await expectProposalState(aaveGovContract, proposals[17].id, proposalStates.QUEUED);
    // // advance to execution
    // const currentBlock = await ethers.provider.getBlock(await ethers.provider.getBlockNumber());
    // const { timestamp } = currentBlock;
    // await increaseTime(queuedProposal18.executionTime.sub(timestamp).toNumber());
  });

  it('Back in Arbitrum', async () => {
    console.log('Change network to Arbitrum');
    DRE.changeNetwork('arbitrumFork');
    console.log(DRE.network.name);
    console.log((await DRE.ethers.provider.getBlockNumber()).toString());
    console.log((await DRE.ethers.provider.getBalance(deployer.address)).toString());
  });

  // describe('ArbitrumBridgeExecutor Authorization', async function () {
  //   it('Unauthorized Transaction - Call Bridge Receiver From Non-EthereumGovernanceExecutor Address', async () => {
  //     const { arbitrumBridgeExecutor } = testEnv;
  //     const { targets, values, signatures, calldatas, withDelegatecalls } =
  //       testEnv.proposalActions[0];
  //     await expect(
  //       arbitrumBridgeExecutor.queue(targets, values, signatures, calldatas, withDelegatecalls)
  //     ).to.be.revertedWith('UNAUTHORIZED_EXECUTOR');
  //   });
  //   it('Unauthorized Update Ethereum Governance Executor - revert', async () => {
  //     const { arbitrumBridgeExecutor, aaveWhale1 } = testEnv;
  //     await expect(
  //       arbitrumBridgeExecutor
  //         .connect(aaveWhale1.signer)
  //         .updateEthereumGovernanceExecutor(aaveWhale1.address)
  //     ).to.be.revertedWith('UNAUTHORIZED_ORIGIN_ONLY_THIS');
  //   });
  // });
  // describe('BridgeExecutorBase - Validate Delay Logic', async function () {
  //   it('Delay > Maximum Delay', async () => {
  //     const { polygonBridgeExecutor } = testEnv;
  //     const polygonBridgeExecutorSigner = await getImpersonatedSigner(
  //       polygonBridgeExecutor.address
  //     );
  //     await expect(
  //       polygonBridgeExecutor.connect(polygonBridgeExecutorSigner).updateDelay(100000000)
  //     ).to.be.revertedWith('DELAY_LONGER_THAN_MAXIMUM');
  //   });
  //   it('Delay < Minimum Delay', async () => {
  //     const { polygonBridgeExecutor } = testEnv;
  //     const polygonBridgeExecutorSigner = await getImpersonatedSigner(
  //       polygonBridgeExecutor.address
  //     );
  //     await expect(
  //       polygonBridgeExecutor.connect(polygonBridgeExecutorSigner).updateDelay(1)
  //     ).to.be.revertedWith('DELAY_SHORTER_THAN_MINIMUM');
  //   });
  // });
  // describe('Queue - ArbitrumBridgeExecutor through Ethereum Aave Governance', async function () {
  //   it('Execute Proposal 17 - successfully queue Arbitrum transaction - duplicate polygon actions', async () => {
  //     const { ethers } = DRE;
  //     const { aaveGovContract, shortExecutor, arbitrumBridgeExecutor } = testEnv;

  //     const { targets, values, signatures, calldatas, withDelegatecalls } =
  //       testEnv.proposalActions[16];

  //     // expectedExecutionTime
  //     const blockNumber = await ethers.provider.getBlockNumber();
  //     const block = await await ethers.provider.getBlock(blockNumber);
  //     const blocktime = block.timestamp;
  //     const expectedExecutionTime = blocktime + 61;

  //     await expect(aaveGovContract.execute(proposals[16].id, overrides))
  //       .to.emit(arbitrumBridgeExecutor, 'ActionsSetQueued')
  //       .withArgs(
  //         0,
  //         targets,
  //         values,
  //         signatures,
  //         calldatas,
  //         withDelegatecalls,
  //         expectedExecutionTime
  //       )
  //       .to.emit(shortExecutor, 'ExecutedAction')
  //       .to.emit(aaveGovContract, 'ProposalExecuted');
  //   });
  // });
  // describe('Confirm ActionSet State - Bridge Executor', async function () {
  //   it('Confirm ActionsSet 0 State', async () => {
  //     const { polygonBridgeExecutor } = testEnv;
  //     const { targets, values, signatures, calldatas, withDelegatecalls, executionTime } =
  //       testEnv.proposalActions[0];

  //     const actionsSet = await polygonBridgeExecutor.getActionsSetById(0);
  //     expect(actionsSet.targets).to.be.eql(targets);
  //     // work around - actionsSet[1] == actionsSet.values
  //     expect(actionsSet[1]).to.be.eql(values);
  //     expect(actionsSet.signatures).to.be.eql(signatures);
  //     expect(actionsSet.calldatas).to.be.eql(calldatas);
  //     expect(actionsSet.withDelegatecalls).to.be.eql(withDelegatecalls);
  //     expect(actionsSet.executionTime).to.be.equal(executionTime);
  //     expect(actionsSet.executed).to.be.false;
  //     expect(actionsSet.canceled).to.be.false;
  //   });
  //   it('Confirm ActionsSet 1 State', async () => {
  //     const { polygonBridgeExecutor } = testEnv;
  //     const { targets, values, signatures, calldatas, withDelegatecalls, executionTime } =
  //       testEnv.proposalActions[1];

  //     const actionsSet = await polygonBridgeExecutor.getActionsSetById(1);

  //     expect(actionsSet.targets).to.be.eql(targets);
  //     // work around - actionsSet[1] == actionsSet.values
  //     expect(actionsSet[1]).to.be.eql(values);
  //     expect(actionsSet.signatures).to.be.eql(signatures);
  //     expect(actionsSet.calldatas).to.be.eql(calldatas);
  //     expect(actionsSet.withDelegatecalls).to.be.eql(withDelegatecalls);
  //     expect(actionsSet.executionTime).to.be.equal(executionTime);
  //     expect(actionsSet.executed).to.be.false;
  //     expect(actionsSet.canceled).to.be.false;
  //   });
  // });
  // describe('Execute Action Sets - Aave Arbitrum Governance', async function () {
  //   it('Execute Action Set 0 - update ethereum governance executor', async () => {
  //     const { arbitrumBridgeExecutor, shortExecutor, aaveWhale2 } = testEnv;

  //     await expect(arbitrumBridgeExecutor.execute(0))
  //       .to.emit(arbitrumBridgeExecutor, 'EthereumGovernanceExecutorUpdate')
  //       .withArgs(
  //         DRE.ethers.utils.getAddress(shortExecutor.address),
  //         DRE.ethers.utils.getAddress(aaveWhale2.address)
  //       );
  //   });
  // });
  // describe('ArbitrumBridgeExecutor Getters - EthereumGovernanceExecutor', async function () {
  //   it('Get EthereumGovernanceExecutor', async () => {
  //     const { arbitrumBridgeExecutor, aaveWhale2 } = testEnv;
  //     expect(await arbitrumBridgeExecutor.getEthereumGovernanceExecutor()).to.be.equal(
  //       DRE.ethers.utils.getAddress(aaveWhale2.address)
  //     );
  //   });
  // });
});
