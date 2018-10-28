set -xe

CLONE_URL=$(aws cloudformation describe-stacks --stack-name ecsInfrastructurePipeline --profile $2 | grep git-codecommit | awk '{ print $2 }' | sed s/\"//g)
git remote add $1 ${CLONE_URL}

git config --local credential.helper $(echo '!aws --profile $2 codecommit credential-helper $@' | sed s/\$2/$2/)
git config --local credential.UseHttpPath true
