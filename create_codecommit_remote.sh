set -e

CLONE_URL=$(aws cloudformation describe-stacks --stack-name ecsInfrastructurePipeline --profile $2 | grep git-codecommit | awk '{ print $2 }' | sed s/\"//g)
git remote add $1 ${CLONE_URL}
